// The emana pipeline's running agents (role, card, time on it), read from emana-brain's
// read-only pipeline_agents.py: the dispatcher registry has one source of truth there.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SCRIPT = join(homedir(), 'Projects', 'emana.ai', 'emana-brain', 'scripts', 'despachante', 'pipeline_agents.py')
const UNREAD = { agents: null }

// Registry phase -> on-screen role (Portuguese on purpose, like the rest of the side bar).
export const ROLE = { dev: 'dev', revisor: 'revisor', pm: 'PM', arq: 'arquiteto', consulta: 'consulta' }

export function parseAgents(doc) {
  if (!Array.isArray(doc?.agents)) return UNREAD
  const agents = doc.agents
    .filter(a => typeof a?.card === 'string' && typeof a?.role === 'string' && Number.isFinite(a?.since))
    .map(a => ({ role: a.role, card: a.card, title: a.title ?? null, since: a.since, alive: a.alive ?? null, stale: Boolean(a.stale) }))
  return { agents }
}

/** Time on the card, from the run start; recomputed at render so it ticks between polls. */
export function onCard(since, now = Date.now() / 1000) {
  const s = Math.max(0, Math.floor(now - since))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`
}

export function fetchAgents(run = execFile) {
  return new Promise(resolve => {
    run('python3', ['-B', SCRIPT, '--json'], { timeout: 15000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) return resolve(UNREAD)
      try { resolve(parseAgents(JSON.parse(stdout))) } catch { resolve(UNREAD) }
    })
  })
}

export function usePipelineAgents(React, ms = 20000) {
  const [state, setState] = React.useState({ ...UNREAD, now: Date.now() / 1000, loading: true })
  React.useEffect(() => {
    let alive = true
    const poll = () => fetchAgents().then(d => { if (alive) setState({ ...d, now: Date.now() / 1000 }) })
    poll()
    const timer = setInterval(poll, ms)
    return () => { alive = false; clearInterval(timer) }
  }, [ms])
  return state
}
