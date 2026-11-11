// This month's Claude API (pay-per-token) cost of the Anthropic organization, as Anthropic bills it:
// the Usage and Cost Analytics API read with an Admin key from the login Keychain (owner decision
// 2026-11-11). Only the provider's own number matches the invoice; a local token estimate did not
// for Gemini. A failed reading shows its reason, never zero.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const CACHE = join(HOME, 'state', 'tui-claude-api-month-usd.json')
const LOCK = CACHE + '.lock'
export const KEYCHAIN = { service: 'emana-anthropic-admin', account: 'custo' }
export const ENDPOINT = 'https://api.anthropic.com/v1/organizations/analytics/cost'
const EMPTY = { usd: null, month: null, refreshedAt: null, error: 'sem leitura' }

// The calendar month in UTC, the day boundary of Anthropic's billing buckets.
export function monthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { start: start.toISOString().replace('.000Z', 'Z'), month: start.toISOString().slice(0, 7) }
}

// `amount` is post-discount, pre-credit, in fractional US cents; one row when nothing is grouped.
export function parseCost(doc, month) {
  if (!Array.isArray(doc?.data)) return { ...EMPTY, error: doc?.error?.type === 'authentication_error' ? 'chave admin recusada' : 'sem leitura' }
  let cents = 0
  for (const row of doc.data) {
    const amount = Number(row?.cost?.amount)
    if (row?.cost?.currency !== 'USD' || !Number.isFinite(amount) || amount < 0) return EMPTY
    cents += amount
  }
  if (doc.has_more) return { ...EMPTY, error: 'resposta paginada' }
  return { usd: cents / 100, month, refreshedAt: doc.data_refreshed_at ?? null, error: null }
}

export function readAdminKey(run = execFile) {
  return new Promise(resolve => {
    run('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'],
      { timeout: 10000, maxBuffer: 4096 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null))
  })
}

export async function fetchCost({ now = new Date(), readKey = readAdminKey, http = fetch } = {}) {
  const key = await readKey()
  if (!key) return { ...EMPTY, error: 'sem chave admin no Keychain' }
  const { start, month } = monthRange(now)
  try {
    const response = await http(`${ENDPOINT}?starting_at=${encodeURIComponent(start)}`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'analytics-usage-cost-2026-08-24' },
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 401 || response.status === 403) return { ...EMPTY, error: 'chave admin recusada' }
    if (!response.ok) return { ...EMPTY, error: 'Anthropic indisponível' }
    return parseCost(await response.json(), month)
  } catch {
    return { ...EMPTY, error: 'Anthropic indisponível' }
  }
}

export function formatUsd(usd) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(usd)
}

export function formatRefreshed(iso) {
  const at = new Date(iso || '')
  if (Number.isNaN(at.getTime())) return 'atualização desconhecida'
  return 'dados até ' + at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Anthropic refreshes the export about every 4 hours, so a 10-minute cache costs nothing in freshness.
export async function loadClaudeApiCost() {
  let cached
  try { cached = JSON.parse(await readFile(CACHE, 'utf8')) } catch {}
  const age = Date.now() - Number(cached?.at || 0)
  if (age >= 0 && age < (cached?.data?.usd != null ? 600000 : 60000)) return cached.data

  await mkdir(join(HOME, 'state'), { recursive: true })
  try {
    if (Date.now() - (await stat(LOCK)).mtimeMs > 60000) await rm(LOCK, { recursive: true, force: true })
  } catch {}
  try { await mkdir(LOCK) } catch { return cached?.data ?? EMPTY }
  try {
    const data = await fetchCost()
    const temp = CACHE + '.' + process.pid
    await writeFile(temp, JSON.stringify({ at: Date.now(), data }), { mode: 0o600 })
    await rename(temp, CACHE)
    return data
  } finally {
    await rm(LOCK, { recursive: true, force: true })
  }
}

export function useClaudeApiCost(React) {
  const [cost, setCost] = React.useState(EMPTY)
  React.useEffect(() => {
    let alive = true
    const tick = () => loadClaudeApiCost().then(data => { if (alive) setCost(data) }).catch(() => {})
    tick()
    const timer = setInterval(tick, 60000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return cost
}
