// Agents a command of yours reports as running (role, task, time on it), for the side bar's `agents` section.
// Configured by the `agents` section of tui-sidebar.json: `command` is an argv (no shell) whose stdout is
//   {"agents": [{"role": "dev", "card": "TASK-12", "title": "...", "since": <unix seconds>, "seconds": 42,
//                "alive": true | false | null, "stale": false}]}
// `card` is any task identifier; `alive` false = the agent's process is gone (✕), `stale` = its lease or
// heartbeat expired (◷). A non-zero exit or unparsable output is "unavailable", never "no agents".
import { execFile } from 'node:child_process'

const UNREAD = { agents: null }

export function parseAgents(doc) {
  if (!Array.isArray(doc?.agents)) return UNREAD
  const agents = doc.agents
    .filter(a => typeof a?.card === 'string' && typeof a?.role === 'string' && Number.isFinite(a?.since))
    .map(a => ({ role: a.role, card: a.card, title: a.title ?? null, since: a.since, alive: a.alive ?? null, stale: Boolean(a.stale) }))
  return { agents }
}

/** Time on the task, from its start; recomputed at render so it ticks between polls. */
export function formatElapsed(since, now = Date.now() / 1000) {
  const s = Math.max(0, Math.floor(now - since))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`
}

export function fetchAgents(command, run = execFile) {
  return new Promise(resolve => {
    run(command[0], command.slice(1), { timeout: 15000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) return resolve(UNREAD)
      try { resolve(parseAgents(JSON.parse(stdout))) } catch { resolve(UNREAD) }
    })
  })
}

export function useAgents(React, cfg) {
  const [state, setState] = React.useState({ ...UNREAD, now: Date.now() / 1000, loading: true })
  const key = JSON.stringify(cfg.command)
  const ms = cfg.refreshSeconds * 1000
  React.useEffect(() => {
    let alive = true
    const poll = () => fetchAgents(cfg.command).then(d => { if (alive) setState({ ...d, now: Date.now() / 1000 }) })
    poll()
    const timer = setInterval(poll, ms)
    return () => { alive = false; clearInterval(timer) }
  }, [key, ms])
  return state
}
