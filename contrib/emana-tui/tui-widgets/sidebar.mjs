/**
 * VS Code style right side bar (secondary side bar): activity bar + explorer (pinned and
 * recent sessions, cron jobs, live background activity, command hints), full height,
 * side-bar background. /sidebar toggles it. Click a section title to collapse/expand it.
 * On-screen labels are Portuguese on purpose (the owner reads them); code is English.
 */
import { SOURCE_ICON, ago, fit, usePoll, when } from './lib/data.mjs'
// Version the dependency when its API changes: the widget host reloads only top-level modules.
import { formatQuotaReset, useWeeklyUsage } from './lib/quota.mjs?v=2'
import { formatMonth, formatUsd, useGeminiSpend } from './lib/gemini.mjs?v=1'
import { ROLE, onCard, usePipelineAgents } from './lib/pipeline.mjs?v=1'

const W = 42 // colunas reservadas pelo rail (host usa paddingX 1 → card = W - 2)
const CARD = W - 2
const BAR = 3 // activity bar
const INNER = CARD - BAR - 1 /* divisória */ - 2 /* padding */ // texto útil
const CHROME = 0 // linhas ocupadas acima do rail (0 = rail vai do topo ao rodapé)

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  // Collapsible Explorer-style section:  ⌄ SESSÕES ················ 3
  function Section({ t, title, count, children }) {
    const [open, setOpen] = React.useState(true)
    const badge = typeof count === 'number' ? ` ${count} ` : ''

    return h(
      Box,
      { flexDirection: 'column', marginBottom: open ? 1 : 0 },
      h(
        Box,
        { flexDirection: 'row', onClick: () => setOpen(v => !v) },
        h(Text, { color: t.color.muted }, open ? '⌄ ' : '› '),
        h(Text, { bold: true, color: t.color.label }, title.padEnd(INNER - 2 - badge.length)),
        badge ? h(Text, { color: '#ffffff', backgroundColor: t.color.primary }, badge) : null
      ),
      open ? children : null
    )
  }

  function ActivityBar({ t, height }) {
    const icon = (ch, active, key) =>
      h(
        Box,
        { key, flexDirection: 'row', marginBottom: 1 },
        h(Text, { color: active ? t.color.label : t.color.muted }, ' ' + ch),
        h(Text, { color: t.color.primary }, active ? '▕' : ' ')
      )

    return h(
      Box,
      { flexDirection: 'column', width: BAR, height, justifyContent: 'space-between' },
      h(Box, { flexDirection: 'column' }, icon('❐', true, 'a'), icon('⌕', false, 'b'), icon('◷', false, 'c'), icon('⑂', false, 'd')),
      h(Box, { flexDirection: 'column' }, icon('◉', false, 'e'), icon('≡', false, 'f'))
    )
  }

  // One cron job: name + profile; click expands the last run.
  function CronRow({ j, t }) {
    const [open, setOpen] = React.useState(false)
    const muted = s => h(Text, { color: t.color.muted }, s)
    const on = j.enabled !== false && !j._error
    const failed = j.last_status && !['ok', 'success', 'silent'].includes(String(j.last_status).toLowerCase())
    const tag = j._profile ? ` ${j._profile}` : ''
    const name = fit(j.name || j.prompt || j.id, INNER - 3 - tag.length)

    return h(
      Box,
      { flexDirection: 'column', onClick: () => setOpen(v => !v) },
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, { color: j._error || failed ? t.color.error : on ? t.color.ok : t.color.warn }, j._error ? ' ✕ ' : on ? ' ▶ ' : ' ⏸ '),
        h(Text, { color: t.color.text }, name),
        h(Text, { color: t.color.accent }, tag)
      ),
      muted('   ' + fit(`${j.schedule_display || ''} · próx ${when(j.next_run_at)}`, INNER - 3)),
      open
        ? h(
            Box,
            { flexDirection: 'column' },
            muted('   ' + fit(`última ${when(j.last_run_at)} · ${j.last_status || '—'}`, INNER - 3)),
            j.last_error ? h(Text, { color: t.color.error }, '   ' + fit(j.last_error, INNER - 3)) : null,
            muted('   ' + fit(`id ${j.id}${j._profile ? ` · perfil ${j._profile}` : ''}`, INNER - 3))
          )
        : null
    )
  }

  // Pipeline agents: role, card, time on it. A claim is not proof its worker runs,
  // so a vanished process (✕) or an expired lease (◷) is shown, not hidden.
  function PipelineSection({ t }) {
    const { agents, now, loading } = usePipelineAgents(React)
    const muted = (s, key) => h(Text, { key, color: t.color.muted }, s)
    let rows
    if (loading) rows = [muted('  carregando…', 'l')]
    else if (!agents) rows = [muted('  sem leitura do despachante', 'u')]
    else if (!agents.length) rows = [muted('  Nenhum agente rodando', 'n')]
    else
      rows = agents.map(a => {
        const [glyph, tone] = a.alive === false ? ['✕', 'error'] : a.stale ? ['◷', 'warn'] : ['●', 'ok']
        const time = onCard(a.since, now).padStart(6)
        return h(
          Box,
          { key: a.card + a.role, flexDirection: 'row' },
          h(Text, { color: t.color[tone] }, ` ${glyph} `),
          h(Text, { color: t.color.text }, fit(ROLE[a.role] || a.role, 10).padEnd(10)),
          h(Text, { color: t.color.accent }, fit(a.card, INNER - 3 - 10 - time.length).padEnd(INNER - 3 - 10 - time.length)),
          h(Text, { color: t.color.muted }, time)
        )
      })
    return h(Section, { t, title: 'PIPELINE', count: agents?.length }, ...rows)
  }

  function Explorer({ t, height }) {
    const scrollRef = React.useRef(null)
    const { sessions, crons } = usePoll(React)
    const hasSessions = Boolean(sessions)
    React.useEffect(() => {
      // First paint may grow from a loading row to the full list: start at the
      // explorer header, then preserve the user's position on later polls.
      if (hasSessions) scrollRef.current?.scrollTo?.(0)
    }, [hasSessions])
    const { sid } = sdk.useSessionInfo()
    // Without the fork's sdk patch (older sdk) the footer just shows the hints.
    const activity = sdk.useLiveActivity ? sdk.useLiveActivity() : { agents: [], processes: [], bgTasks: [], running: 0 }
    const busyRows = activity.agents.length + activity.processes.length + activity.bgTasks.length
    const muted = (s, key) => h(Text, { key, color: t.color.muted }, s)

    const sessionRow = (r, active) => {
      const live = !r.ended_at
      const time = ago(r.at).padStart(6) + ' '
      const bg = active ? t.color.completionCurrentBg : undefined

      return h(
        Box,
        { key: r.id, flexDirection: 'row', onClick: () => !active && sdk.runSlash(`/sessions ${r.id}`) },
        h(Text, { backgroundColor: bg, color: live ? t.color.ok : t.color.muted }, live ? ' ● ' : ` ${SOURCE_ICON[r.source] || '·'} `),
        h(Text, { backgroundColor: bg, color: active ? '#ffffff' : t.color.text }, fit(r.title, INNER - 3 - time.length)),
        h(Text, { backgroundColor: bg, color: active ? t.color.text : t.color.muted }, time)
      )
    }

    const pinned = sessions?.pinned ?? []
    const recentLimit = pinned.length ? 6 : 8
    let sessionRows
    if (!sessions) sessionRows = [muted('  carregando…', 'l')]
    else if (sessions.error) sessionRows = [h(Text, { key: 'e', color: t.color.error }, '  ' + sessions.error)]
    else if (!sessions.rows.length) sessionRows = [muted('  Nenhuma sessão ainda', 'n')]
    else
      // With pinned sessions on top, recent ones give up two rows.
      sessionRows = sessions.rows
        .slice(0, recentLimit)
        .map((r, i) => sessionRow(r, sid ? r.id === sid : !pinned.length && i === 0))

    const pinnedRows = pinned.map(r => sessionRow(r, Boolean(sid) && r.id === sid))

    let cronRows
    if (crons.error) cronRows = [h(Text, { key: 'e', color: t.color.error }, '  ' + crons.error)]
    else if (!crons.rows.length)
      cronRows = [muted('  Nenhuma tarefa agendada', 'n'), h(Text, { key: 'h', color: t.color.accent }, '  + /cron add para criar')]
    else
      cronRows = crons.rows.map((j, i) => h(CronRow, { key: `${j._profile}:${j.id || i}`, j, t }))

    return h(
      Box,
      { flexDirection: 'column', width: INNER + 2, height, paddingX: 1 },
      h(
        sdk.ScrollBox || Box,
        { flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, ref: scrollRef, stickyScroll: false },
        h(Box, { flexDirection: 'column', flexShrink: 0 },
        h(
          Box,
          { flexDirection: 'row', marginBottom: 1 },
          h(Text, { color: t.color.muted }, 'EXPLORADOR'.padEnd(INNER - 3)),
          h(Text, { color: t.color.muted }, '···')
        ),
        pinnedRows.length ? h(Section, { t, title: 'FIXADAS', count: pinnedRows.length }, ...pinnedRows) : null,
        h(Section, { t, title: 'SESSÕES', count: sessions?.rows ? Math.min(sessions.rows.length, recentLimit) : undefined }, ...sessionRows),
        h(PipelineSection, { t }),
        h(Section, { t, title: 'AGENDADOS', count: crons.rows?.length }, ...cronRows)
        )
      ),
      h(Box, { flexDirection: 'row', flexShrink: 0 },
        h(Box, { onClick: () => scrollRef.current?.scrollBy?.(-5) }, h(Text, { color: t.color.accent }, ' ↑ ')),
        h(Text, { color: t.color.muted }, 'rolar lista'),
        h(Box, { onClick: () => scrollRef.current?.scrollBy?.(5) }, h(Text, { color: t.color.accent }, ' ↓ '))
      ),
      // Footer: live activity (when any) ABOVE the command hints, which always stay.
      h(
        Box,
        { flexDirection: 'column', flexShrink: 0 },
        busyRows ? h(Activity, { t, activity }) : null,
        h(WeeklyQuota, { t }),
        h(Text, { color: t.color.border }, '─'.repeat(INNER)),
        ...HINTS.map(([cmd, label]) =>
          h(
            Box,
            { key: cmd, flexDirection: 'row', onClick: () => sdk.runSlash(cmd) },
            h(Text, { color: t.color.accent }, cmd.padEnd(9)),
            muted('  ' + label)
          )
        )
      )
    )
  }

  // Metered, so a month's spend instead of a weekly window; labelled as an estimate on screen.
  function GeminiSpend({ t }) {
    const spend = useGeminiSpend(React)
    const valid = typeof spend.usd === 'number'
    const note = !valid ? 'sem leitura'
      : spend.unpriced ? `${spend.unpriced} run(s) sem preço, fora do total`
      : `estimativa por tokens · ${spend.runs} ${spend.runs === 1 ? 'run' : 'runs'}`
    return h(Box, { flexDirection: 'column' },
      h(Box, { flexDirection: 'row' },
        h(Text, { color: t.color.text }, 'Gemini'.padEnd(8)),
        h(Text, { color: valid ? t.color.accent : t.color.muted }, valid ? formatUsd(spend.usd) : '—'),
        h(Text, { color: t.color.muted }, ' em ' + formatMonth(spend.month))),
      h(Text, { color: spend.unpriced ? t.color.warn : t.color.muted }, fit(note, INNER).trimEnd()))
  }

  // Footer hints; clicking runs the command. Bare /model opens the session's model picker.
  function WeeklyQuota({ t }) {
    const usage = useWeeklyUsage(React)
    const rows = [['Claude', 'anthropic'], ['Codex', 'openai-codex']].map(([name, provider]) => {
      const pct = usage[provider]?.percent
      const valid = typeof pct === 'number'
      const filled = valid ? Math.min(10, Math.max(0, Math.round(pct / 10))) : 0
      const bar = valid ? '█'.repeat(filled) + '░'.repeat(10 - filled) : '──────────'
      const value = valid ? `${pct.toFixed(0)}%` : '—'
      const color = !valid ? t.color.muted : pct >= 95 ? t.color.error : pct >= 80 ? t.color.warn : t.color.accent
      return h(Box, { key: provider, flexDirection: 'column' },
        h(Box, { flexDirection: 'row' },
          h(Text, { color: t.color.text }, name.padEnd(8)),
          h(Text, { color }, bar + ' ' + value.padStart(4)),
          !valid ? h(Text, { color: t.color.muted }, ' sem leitura') : null),
        h(Text, { color: t.color.muted }, fit('renova ' + formatQuotaReset(usage[provider]?.reset), INNER).trimEnd()))
    })
    return h(Box, { flexDirection: 'column', flexShrink: 0 },
      h(Text, { color: t.color.border }, '─'.repeat(INNER)),
      h(Text, { bold: true, color: t.color.label }, 'CONSUMO DE LLM · CONTA'),
      ...rows,
      h(GeminiSpend, { t }))
  }

  const HINTS = [
    ['/sessions', 'trocar de sessão'],
    ['/new', 'nova conversa'],
    ['/title', 'renomear a sessão'],
    ['/pin', 'fixar/desafixar'],
    ['/model', 'trocar o modelo'],
    ['/agents', 'subagentes']
  ]

  // Footer block: subagents, background processes and /bg prompts of the current session.
  const AGENT_GLYPH = {
    running: ['●', 'accent'], queued: ['○', 'muted'], dispatched: ['○', 'muted'], finalizing: ['◐', 'accent'],
    completed: ['✓', 'ok'], interrupted: ['■', 'warn'], cancelled: ['■', 'warn'], rejected: ['⊘', 'warn'],
    failed: ['✗', 'error'], timeout: ['◷', 'warn'], error: ['!', 'error']
  }
  // '$', not '⚙': ⚙ may render as a 2-column emoji and misalign the row.
  const PROC_GLYPH = { running: ['$', 'accent'], done: ['✓', 'ok'], failed: ['✗', 'error'], killed: ['■', 'warn'], lost: ['?', 'warn'] }
  const dur = s => (s == null ? '' : s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`)

  function Activity({ t, activity }) {
    const { agents, processes, bgTasks, running } = activity
    const tone = k => t.color[k] || t.color.muted
    const rows = []

    for (const a of agents.slice(0, 4)) {
      const [g, c] = AGENT_GLYPH[a.status] || ['·', 'muted']
      const time = ' ' + dur(a.elapsedSeconds)
      rows.push(
        h(
          Box,
          { key: 'a' + a.key, flexDirection: 'column', onClick: () => sdk.runSlash('/agents') },
          h(
            Box,
            { flexDirection: 'row' },
            h(Text, { color: tone(c) }, ` ${g} `),
            h(Text, { color: t.color.text }, fit(a.goal, INNER - 3 - time.length)),
            h(Text, { color: t.color.muted }, time)
          ),
          h(Text, { color: t.color.muted }, '   ↳ ' + fit(a.detail, INNER - 5))
        )
      )
    }
    for (const p of processes.slice(0, 3)) {
      const [g, c] = PROC_GLYPH[p.status] || ['·', 'muted']
      // uptime comes from the snapshot (event-driven, not clock-driven): 0 = no reading yet.
      const time = p.status === 'running' && p.elapsedSeconds > 0 ? ' ' + dur(p.elapsedSeconds) : ''
      rows.push(
        h(
          Box,
          { key: 'p' + p.id, flexDirection: 'row' },
          h(Text, { color: tone(c) }, ` ${g} `),
          h(Text, { color: t.color.text }, fit(p.command, INNER - 3 - time.length)),
          h(Text, { color: t.color.muted }, time)
        )
      )
    }
    if (bgTasks.length)
      rows.push(
        h(Text, { key: 'bg', color: t.color.accent }, fit(` ◌ ${bgTasks.length} prompt${bgTasks.length > 1 ? 's' : ''} /bg rodando`, INNER))
      )
    const hidden = Math.max(0, agents.length - 4) + Math.max(0, processes.length - 3)
    if (hidden) rows.push(h(Text, { key: 'more', color: t.color.muted }, `   +${hidden} — /agents para ver tudo`))

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: t.color.border }, '─'.repeat(INNER)),
      h(Section, { t, title: 'EM EXECUÇÃO', count: running + bgTasks.length }, ...rows)
    )
  }

  const app = defineWidgetApp({
    id: 'sidebar',
    help: 'VS Code style side bar: sessions, cron jobs, live activity',
    mode: 'ambient',
    zone: 'top-right',
    width: W,
    init: () => ({}),
    reduce: (state, { ch, key }) => (key.escape || ch === 'q' ? null : state),
    render: ({ t, rows }) => {
      const height = Math.max(14, rows - CHROME)
      return h(
        Box,
        {
          flexDirection: 'row',
          width: CARD,
          height,
          opaque: true,
          backgroundColor: t.color.statusBg,
          borderStyle: 'single',
          borderTop: false,
          borderBottom: false,
          borderRight: false,
          borderColor: t.color.border
        },
        h(Explorer, { t, height }),
        h(ActivityBar, { t, height })
      )
    }
  })

  sdk.openWidget(app, app.init(''))
}
