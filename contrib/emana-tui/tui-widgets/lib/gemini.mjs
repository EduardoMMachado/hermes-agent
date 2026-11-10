// This month's Gemini (Vertex) cost in emana-ai-dev, from Google's own token counts x the BRL
// catalog price (owner decision 2026-11-10), computed by emana-brain's read-only gemini_spend.py.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const CACHE = join(HOME, 'state', 'tui-gemini-month-brl.json')
const LOCK = CACHE + '.lock'
export const SCRIPT = join(homedir(), 'Projects', 'emana.ai', 'emana-brain', 'scripts', 'despachante', 'gemini_spend.py')
const EMPTY = { brl: null, month: null, unpriced: [], error: 'sem leitura' }

export function parseSpend(doc) {
  if (typeof doc?.error === 'string') return { ...EMPTY, error: doc.error }
  const brl = doc?.brl
  if (typeof brl !== 'number' || !Number.isFinite(brl) || brl < 0 || doc?.estimate !== true) return EMPTY
  return { brl, month: doc.month ?? null, unpriced: Array.isArray(doc.unpriced_models) ? doc.unpriced_models : [], error: null }
}

export function formatBrl(brl) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(brl)
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function formatMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  return m ? `${MONTHS[Number(m[2]) - 1]}/${m[1]}` : 'mês'
}

// A failed reading exits 1 but still prints {"error": ...}: keep the reason for the screen.
export function fetchSpend(run = execFile) {
  return new Promise(resolve => {
    run('python3', ['-B', SCRIPT, '--json'], { timeout: 25000, maxBuffer: 64 * 1024 }, (_error, stdout) => {
      try { resolve(parseSpend(JSON.parse(stdout))) } catch { resolve(EMPTY) }
    })
  })
}

export async function loadGeminiSpend() {
  let cached
  try { cached = JSON.parse(await readFile(CACHE, 'utf8')) } catch {}
  const age = Date.now() - Number(cached?.at || 0)
  if (age >= 0 && age < (cached?.data?.brl != null ? 300000 : 60000)) return cached.data

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
