// The side bar's one local config file, `$HERMES_HOME/tui-sidebar.json` (HERMES_HOME or ~/.hermes, so it is
// per profile). Every section is optional and turns on one row:
//   vertexSpend -> this month's Vertex AI cost, claudeApi -> this month's Claude API cost,
//   agents      -> a section listing the agents a command of yours reports as running.
// A missing file or a file that is not a JSON object hides every optional row; a malformed section is
// returned as { error } so its row says "config inválida" instead of crashing or guessing.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
export const CONFIG_PATH = join(HOME, 'tui-sidebar.json')
export const INVALID = 'config inválida'

const bad = { error: INVALID }
const text = v => typeof v === 'string' && v.trim() !== ''
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function keychain(v) {
  return object(v) && text(v.service) && text(v.account) ? { service: v.service, account: v.account } : null
}

export function validateVertexSpend(v) {
  if (!object(v)) return bad
  const prices = v.inputPricePerToken
  const priced = object(prices) && Object.keys(prices).length > 0 &&
    Object.values(prices).every(p => typeof p === 'number' && Number.isFinite(p) && p > 0)
  const item = v.keychain === undefined ? null : keychain(v.keychain)
  const gcloud = v.tokenFromGcloud === true
  if (!text(v.project) || !/^[A-Z]{3}$/.test(v.currency ?? '') || !priced) return bad
  if ((v.keychain !== undefined && !item) || (!item && !gcloud)) return bad
  if (v.label !== undefined && !text(v.label)) return bad
  return {
    project: v.project,
    currency: v.currency,
    inputPricePerToken: { ...prices },
    keychain: item,
    tokenFromGcloud: gcloud,
    label: v.label ?? 'Vertex',
    priceSource: text(v.priceSource) ? v.priceSource : null
  }
}

export function validateClaudeApi(v) {
  if (!object(v)) return bad
  const item = keychain(v.keychain)
  if (!item || (v.label !== undefined && !text(v.label))) return bad
  return { keychain: item, label: v.label ?? 'API' }
}

export function validateAgents(v) {
  if (!object(v)) return bad
  const command = v.command
  if (!Array.isArray(command) || !command.length || !command.every(text)) return bad
  if (v.title !== undefined && !text(v.title)) return bad
  const refresh = v.refreshSeconds ?? 20
  if (typeof refresh !== 'number' || !Number.isFinite(refresh) || refresh < 2) return bad
  const labels = v.roleLabels ?? {}
  if (!object(labels) || !Object.values(labels).every(text)) return bad
  return { title: v.title ?? 'AGENTES', command: [...command], refreshSeconds: refresh, roleLabels: { ...labels } }
}

const SECTIONS = { vertexSpend: validateVertexSpend, claudeApi: validateClaudeApi, agents: validateAgents }

/** Sections absent from `doc` stay undefined (row hidden); present ones are validated. */
export function parseConfig(doc) {
  if (!object(doc)) return {}
  const out = {}
  for (const [name, validate] of Object.entries(SECTIONS)) {
    if (doc[name] !== undefined && doc[name] !== null) out[name] = validate(doc[name])
  }
  return out
}

let memo = { path: null, stamp: null, config: {} }

/** The config, re-read only when the file changes (cheap enough to call on every render). */
export function readConfig(path = CONFIG_PATH) {
  let stamp
  try {
    const s = statSync(path)
    stamp = `${s.mtimeMs}:${s.size}`
  } catch {
    return {}
  }
  if (memo.path === path && memo.stamp === stamp) return memo.config
  let config = {}
  try { config = parseConfig(JSON.parse(readFileSync(path, 'utf8'))) } catch {}
  memo = { path, stamp, config }
  return config
}

/** A section's cache identity: a changed setting must not show the previous setting's reading. */
export const configKey = section => JSON.stringify(section ?? null)
