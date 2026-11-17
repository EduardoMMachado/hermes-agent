// This month's Vertex AI cost of one Google Cloud project: Google's own token counts (Cloud Monitoring) x the
// input price per token you configure, computed by the bundled read-only bin/vertex_spend.py. Configured by
// the `vertexSpend` section of tui-sidebar.json; a failed reading shows its reason, never zero.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const CACHE = join(HOME, 'state', 'tui-vertex-month-spend.json')
const LOCK = CACHE + '.lock'
// Relative to this module, so it works from any checkout and through the $HERMES_HOME/tui-widgets symlink.
export const SCRIPT = fileURLToPath(new URL('../bin/vertex_spend.py', import.meta.url))
const EMPTY = { amount: null, currency: null, month: null, unpriced: [], error: 'sem leitura' }

/** The script's argv for a validated `vertexSpend` section (no secret ever goes here: only the item's name). */
export function scriptArgs(cfg) {
  const args = ['-B', SCRIPT, '--json', '--project', cfg.project, '--currency', cfg.currency]
  for (const [model, price] of Object.entries(cfg.inputPricePerToken)) args.push('--price', `${model}=${price}`)
  if (cfg.keychain) args.push('--keychain-service', cfg.keychain.service, '--keychain-account', cfg.keychain.account)
  else args.push('--token-from-gcloud')
  if (cfg.priceSource) args.push('--price-source', cfg.priceSource)
  return args
}

export function parseSpend(doc) {
  if (typeof doc?.error === 'string') return { ...EMPTY, error: doc.error }
  const amount = doc?.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || doc?.estimate !== true) return EMPTY
  if (typeof doc.currency !== 'string' || !/^[A-Z]{3}$/.test(doc.currency)) return EMPTY
  return {
    amount,
    currency: doc.currency,
    month: doc.month ?? null,
    unpriced: Array.isArray(doc.unpriced_models) ? doc.unpriced_models : [],
    error: null
  }
}

export function formatMoney(amount, currency) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(amount)
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function formatMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  return m ? `${MONTHS[Number(m[2]) - 1]}/${m[1]}` : 'mês'
}

// A failed reading exits 1 but still prints {"error": ...}: keep the reason for the screen.
export function fetchSpend(cfg, run = execFile) {
  return new Promise(resolve => {
    run('python3', scriptArgs(cfg), { timeout: 25000, maxBuffer: 64 * 1024 }, (_error, stdout) => {
      try { resolve(parseSpend(JSON.parse(stdout))) } catch { resolve(EMPTY) }
    })
  })
}

export async function loadVertexSpend(cfg, fetcher = fetchSpend) {
  const key = JSON.stringify(cfg)
  let cached
  try { cached = JSON.parse(await readFile(CACHE, 'utf8')) } catch {}
  if (cached?.key !== key) cached = undefined
  const age = Date.now() - Number(cached?.at || 0)
  if (age >= 0 && age < (cached?.data?.amount != null ? 300000 : 60000)) return cached.data

  await mkdir(join(HOME, 'state'), { recursive: true })
  try {
    if (Date.now() - (await stat(LOCK)).mtimeMs > 60000) await rm(LOCK, { recursive: true, force: true })
  } catch {}
  try { await mkdir(LOCK) } catch { return cached?.data ?? EMPTY }
  try {
    const data = await fetcher(cfg)
    const temp = CACHE + '.' + process.pid
    await writeFile(temp, JSON.stringify({ at: Date.now(), key, data }), { mode: 0o600 })
    await rename(temp, CACHE)
    return data
  } finally {
    await rm(LOCK, { recursive: true, force: true })
  }
}

export function useVertexSpend(React, cfg) {
  const [spend, setSpend] = React.useState(EMPTY)
  const key = JSON.stringify(cfg)
  React.useEffect(() => {
    let alive = true
    const tick = () => loadVertexSpend(cfg).then(data => { if (alive) setSpend(data) }).catch(() => {})
    tick()
    const timer = setInterval(tick, 60000)
    return () => { alive = false; clearInterval(timer) }
  }, [key])
  return spend
}
