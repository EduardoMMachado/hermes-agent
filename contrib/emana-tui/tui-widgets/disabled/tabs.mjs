/**
 * VS Code style tab bar + breadcrumbs at the top of the screen (`header` zone).
 * Tabs = recent sessions. Click a tab to switch session, × to drop it from the
 * bar, + to open a new chat. /tabs toggles it. DISABLED: to enable, move it to
 * the parent directory and change the import to './lib/data.mjs'.
 */
import { fit, tildify, usePoll } from '../lib/data.mjs'

const TAB_MAX = 28

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h } = sdk

  function Header({ t, cols }) {
    const { sessions } = usePoll(React, 3000)
    const { sid, busy } = sdk.useSessionInfo()
    const [hidden, setHidden] = React.useState(() => new Set())
    const [pending, setPending] = React.useState(null)
    const order = React.useRef([]) // stable tab order (tabs don't jump on switch)

    React.useEffect(() => {
      if (pending && pending === sid) setPending(null)
    }, [sid, pending])

    const byId = new Map((sessions?.rows ?? []).map(r => [r.id, r]))
    // new ids enter at the front; vanished ids leave
    const fresh = [...byId.keys()].filter(id => !order.current.includes(id))
    order.current = [...fresh, ...order.current.filter(id => byId.has(id))]

    const activeId = pending || sid
    const rows = order.current.map(id => byId.get(id)).filter(r => r && (!hidden.has(r.id) || r.id === activeId))
    if (activeId && !byId.has(activeId)) rows.unshift({ id: activeId, title: 'Nova sessão', ended_at: null, cwd: process.cwd() })

    const width = Math.max(20, cols)
    const strip = t.color.statusBg
    const ACTIONS = ' +  ◫  ⋯ '

    const tabs = []
    let used = 0
    for (const r of rows) {
      const label = fit(r.title, Math.min(TAB_MAX, r.title.length + 1))
      const w = label.length + 6 // " ● " + label + " ×" + sep
      if (used + w > width - ACTIONS.length) break
      tabs.push({ r, label, w, active: r.id === activeId })
      used += w
    }
    const rest = Math.max(0, width - used - ACTIONS.length)

    const open = id => {
      if (id === activeId) return
      if (busy) {
        sdk.runSlash(`/sessions ${id}`) // o próprio Hermes avisa que está ocupado
        return
      }
      setPending(id)
      if (!sdk.runSlash(`/sessions ${id}`)) setPending(null)
    }

    const close = (e, id) => {
      e?.stopImmediatePropagation?.()
      setHidden(prev => new Set(prev).add(id))
    }

    // Row 0: blue edge above the active tab.
    const topLine = h(
      Box,
      { flexDirection: 'row' },
      ...tabs.map((tab, i) =>
        h(Text, { key: i, color: t.color.primary, backgroundColor: tab.active ? undefined : strip }, (tab.active ? '▁' : ' ').repeat(tab.w))
      ),
      h(Text, { backgroundColor: strip }, ' '.repeat(rest + ACTIONS.length))
    )

    // Row 1: the (clickable) tabs.
    const tabLine = h(
      Box,
      { flexDirection: 'row' },
      ...tabs.map((tab, i) => {
        const bg = tab.active ? undefined : strip
        const live = !tab.r.ended_at
        const loading = tab.r.id === pending
        const next = tabs[i + 1]
        return h(
          Box,
          { key: tab.r.id, flexDirection: 'row', onClick: () => open(tab.r.id) },
          h(Text, { backgroundColor: bg, color: loading ? t.color.accent : live ? t.color.ok : t.color.muted }, loading ? ' ◌ ' : live ? ' ● ' : ' ▣ '),
          h(Text, { backgroundColor: bg, color: tab.active ? t.color.label : t.color.muted, italic: !tab.active }, tab.label),
          tab.active
            ? h(Text, { backgroundColor: bg, color: t.color.text }, '  ')
            : h(Box, { onClick: e => close(e, tab.r.id) }, h(Text, { backgroundColor: bg, color: t.color.muted }, ' ×')),
          h(Text, { backgroundColor: bg, color: t.color.border }, next && !next.active && !tab.active ? '│' : ' ')
        )
      }),
      h(Text, { backgroundColor: strip }, ' '.repeat(rest)),
      h(Box, { onClick: () => sdk.runSlash('/sessions new') }, h(Text, { backgroundColor: strip, color: t.color.label, bold: true }, ' + ')),
      h(Box, { onClick: () => sdk.runSlash('/sessions') }, h(Text, { backgroundColor: strip, color: t.color.muted }, ' ◫  ⋯ '))
    )

    // Row 2: breadcrumbs of the active session.
    const active = tabs.find(x => x.active)?.r
    const parts = tildify(active?.cwd || process.cwd()).split('/').filter(Boolean)
    const crumbs = []
    parts.forEach((p, i) => {
      crumbs.push(h(Text, { key: 'p' + i, color: t.color.muted }, p))
      crumbs.push(h(Text, { key: 's' + i, color: t.color.muted }, ' › '))
    })
    const crumbLine = h(
      Box,
      { flexDirection: 'row', paddingLeft: 1 },
      ...crumbs,
      h(Text, { color: t.color.accent }, '◆ '),
      h(Text, { color: t.color.text }, fit(active?.title ?? 'Nova sessão', Math.max(10, width - 40)).trimEnd()),
      active?.model ? h(Text, { color: t.color.muted }, '  ·  ' + active.model) : null
    )

    return h(Box, { flexDirection: 'column', width }, topLine, tabLine, crumbLine)
  }

  const app = defineWidgetApp({
    id: 'tabs',
    help: 'clickable tab bar + breadcrumbs at the top (VS Code style)',
    mode: 'ambient',
    zone: 'header',
    init: () => ({}),
    reduce: (state, { ch, key }) => (key.escape || ch === 'q' ? null : state),
    render: ({ t, cols }) => h(Header, { t, cols })
  })

  sdk.openWidget(app, app.init(''))
}
