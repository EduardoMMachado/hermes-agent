// This month's Gemini (Vertex) spend of the emana pipeline: a local ESTIMATE (agy tokens x list price),
// not Google's invoice (owner decision 2026-11-09). The estimate itself lives in emana-brain, one source.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const CACHE = join(HOME, 'state', 'tui-gemini-month.json')
const LOCK = CACHE + '.lock'
export const SCRIPT = join(homedir(), 'Projects', 'emana.ai', 'emana-brain', 'scripts', 'despachante', 'gemini_spend.py')
const EMPTY = { usd: null, month: null, runs: 0, unpriced: 0 }

export function parseSpend(doc) {
  const usd = doc?.usd
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || doc?.estimate !== true) return EMPTY
  return { usd, month: doc.month ?? null, runs: doc.runs ?? 0, unpriced: doc.unpriced_runs ?? 0 }
}

export function formatUsd(usd) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(usd)
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function formatMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  return m ? `${MONTHS[Number(m[2]) - 1]}/${m[1]}` : 'mês'
}

export function fetchSpend(run = execFile) {
  return new Promise(resolve => {
    run('python3', ['-B', SCRIPT, '--json'], { timeout: 25000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) return resolve(EMPTY)
      try { resolve(parseSpend(JSON.parse(stdout))) } catch { resolve(EMPTY) }
    })
  })
}

export async function loadGeminiSpend() {
  let cached
  try { cached = JSON.parse(await readFile(CACHE, 'utf8')) } catch {}
  const age = Date.now() - Number(cached?.at || 0)
  if (age >= 0 && age < (cached?.data?.usd != null ? 300000 : 60000)) return cached.data

  await mkdir(join(HOME, 'state'), { recursive: true })
  try {
    if (Date.now() - (await stat(LOCK)).mtimeMs > 60000) await rm(LOCK, { recursive: true, force: true })
  } catch {}
  try { await mkdir(LOCK) } catch { return cached?.data ?? EMPTY }
  try {
    const data = await fetchSpend()
    const temp = CACHE + '.' + process.pid
    await writeFile(temp, JSON.stringify({ at: Date.now(), data }), { mode: 0o600 })
    await rename(temp, CACHE)
    return data
  } finally {
    await rm(LOCK, { recursive: true, force: true })
  }
}

export function useGeminiSpend(React) {
  const [spend, setSpend] = React.useState(EMPTY)
  React.useEffect(() => {
    let alive = true
    const tick = () => loadGeminiSpend().then(data => { if (alive) setSpend(data) }).catch(() => {})
    tick()
    const timer = setInterval(tick, 60000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return spend
}
