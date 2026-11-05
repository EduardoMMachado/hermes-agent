// Account-wide subscription quota, not session tokens or the pipeline's ceiling.
// Cache and lock are shared by all TUIs in this Hermes home to avoid quota API spam.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const CACHE = join(HOME, 'state', 'tui-weekly-usage.json')
const LOCK = CACHE + '.lock'
const PROVIDERS = ['anthropic', 'openai-codex']
const EMPTY = { anthropic: { percent: null }, 'openai-codex': { percent: null } }

export function weeklyWindow(document) {
  const window = document?.windows?.find(w => ['Current week', 'Weekly'].includes(w.label))
  const percent = window?.used_percent
  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? { percent, reset: window.resets_at ?? null }
    : { percent: null, reset: null }
}

export function fetchWeekly(provider, run = execFile) {
  return new Promise(resolve => {
    run('hermes', ['usage', '--provider', provider, '--json', '--read-only'],
      { timeout: 25000, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error) return resolve({ percent: null, reset: null })
        try { resolve(weeklyWindow(JSON.parse(stdout))) }
        catch { resolve({ percent: null, reset: null }) }
      })
  })
}

export async function loadWeeklyUsage() {
  let cached
  try { cached = JSON.parse(await readFile(CACHE, 'utf8')) } catch {}
  const age = Date.now() - Number(cached?.at || 0)
  const ttl = PROVIDERS.every(p => cached?.data?.[p]?.percent != null) ? 300000 : 60000
  if (age >= 0 && age < ttl) return cached.data

  await mkdir(join(HOME, 'state'), { recursive: true })
  // A crashed CLI cannot leave the shared poller permanently locked.
  try {
    if (Date.now() - (await stat(LOCK)).mtimeMs > 60000) await rm(LOCK, { recursive: true, force: true })
  } catch {}
  try { await mkdir(LOCK) } catch { return EMPTY }
  try {
    const values = await Promise.all(PROVIDERS.map(p => fetchWeekly(p)))
    const data = Object.fromEntries(PROVIDERS.map((p, i) => [p, values[i]]))
    const temp = CACHE + '.' + process.pid
    await writeFile(temp, JSON.stringify({ at: Date.now(), data }), { mode: 0o600 })
    await rename(temp, CACHE)
    return data
  } finally {
    await rm(LOCK, { recursive: true, force: true })
  }
}

export function useWeeklyUsage(React) {
  const [usage, setUsage] = React.useState(EMPTY)
  React.useEffect(() => {
    let alive = true
    const tick = () => loadWeeklyUsage().then(data => { if (alive) setUsage(data) }).catch(() => {})
    tick()
    const timer = setInterval(tick, 30000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return usage
}
