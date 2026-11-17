// Data shared by the widgets (sessions + cron jobs). Not a widget itself: it
// lives in lib/ because the loader only loads top-level .mjs files.
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const DB = join(HOME, 'state.db')
const JOBS = join(HOME, 'cron', 'jobs.json')

const COLS = `id, source, coalesce(title, display_name, 'Sem título') as title,
  ended_at, coalesce(last_activity_at, started_at) as at, message_count, cwd, model, coalesce(pinned,0) as pinned`

// Recent sessions, excluding pinned ones (they have their own section).
const SQL = `select ${COLS} from sessions
  where coalesce(archived,0)=0 and coalesce(hidden,0)=0 and parent_session_id is null
    and message_count > 0 and coalesce(pinned,0)=0
  order by coalesce(last_activity_at, started_at) desc limit 8`

// Pinned: the same `pinned` column the desktop app uses. A pin covers the whole
// compression lineage, so only the tip (no pinned child) is listed.
const SQL_PINNED = `select ${COLS} from sessions s
  where coalesce(s.pinned,0)=1 and coalesce(s.archived,0)=0 and coalesce(s.hidden,0)=0
    and not exists (select 1 from sessions c where c.parent_session_id = s.id and coalesce(c.pinned,0)=1)
  order by coalesce(s.last_activity_at, s.started_at) desc`

const query = sql =>
  new Promise(resolve => {
    execFile('sqlite3', ['-readonly', '-json', DB, sql], { timeout: 4000 }, (err, out) => {
      if (err) return resolve(null)
      try {
        resolve(out.trim() ? JSON.parse(out) : [])
      } catch {
        resolve(null)
      }
    })
  })

export async function loadSessions() {
  const [rows, pinned] = await Promise.all([query(SQL), query(SQL_PINNED)])
  if (!rows || !pinned) return { error: 'state.db indisponível' }
  return { rows, pinned }
}

/** Is the session pinned? Synchronous read (/pin uses it to decide pin vs unpin). */
export function isPinned(id) {
  try {
    const out = execFileSync('sqlite3', ['-readonly', DB, `select coalesce(pinned,0) from sessions where id='${String(id).replace(/'/g, "''")}'`], {
      timeout: 3000
    })
    return String(out).trim() === '1'
  } catch {
    return false
  }
}


// Cron jobs of EVERY profile: the default one (<home>/cron) + <home>/profiles/*/cron.
// Each job gets `_profile` (null = default profile).
function readJobs(file, profile) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const jobs = Array.isArray(data) ? data : data.jobs || []
    return jobs.map(j => ({ ...j, _profile: profile }))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    return [{ id: file, name: 'jobs.json ilegível', _profile: profile, _error: true }]
  }
}

export function loadCrons() {
  const rows = readJobs(JOBS, null)
  let profiles = []
  try {
    profiles = readdirSync(join(HOME, 'profiles'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {}
  for (const p of profiles.sort()) rows.push(...readJobs(join(HOME, 'profiles', p, 'cron', 'jobs.json'), p))
  return { rows }
}

/** Hook: sessions + cron jobs, refreshed every `ms`. */
export function usePoll(React, ms = 5000) {
  const [sessions, setSessions] = React.useState(null)
  const [crons, setCrons] = React.useState(() => loadCrons())

  React.useEffect(() => {
    let alive = true
    const tick = async () => {
      const s = await loadSessions()
      if (alive) {
        setSessions(s)
        setCrons(loadCrons())
      }
    }
    tick()
    const id = setInterval(tick, ms)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return { sessions, crons }
}

export const ago = ts => {
  const s = Math.max(0, Date.now() / 1000 - Number(ts || 0))
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

export const fit = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (n <= 0) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n)
}

export const when = iso => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export const SOURCE_ICON = {
  tui: '▣', cli: '›', local: '›', oneshot: '⚡', cron: '◷', telegram: '✈',
  discord: '◆', slack: '#', whatsapp: '◉', desktop: '▢'
}

export const tildify = p => {
  const home = homedir()
  return p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '~'
}
