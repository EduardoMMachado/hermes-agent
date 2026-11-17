import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { INVALID, parseConfig, readConfig, validateAgents, validateClaudeApi, validateVertexSpend } from '../tui-widgets/lib/config.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tui-sidebar-config-'))
const file = (name, body) => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}
const VERTEX = { project: 'p', currency: 'BRL', inputPricePerToken: { m: 1e-6 }, keychain: { service: 's', account: 'a' } }

test('a missing file or a file that is not a JSON object hides every optional row', () => {
  assert.deepEqual(readConfig(join(dir, 'absent.json')), {})
  assert.deepEqual(readConfig(file('broken.json', '{ not json')), {})
  assert.deepEqual(readConfig(file('array.json', '[1, 2]')), {})
  assert.deepEqual(readConfig(file('empty.json', '{}')), {})
})

test('only the configured sections exist; absent ones stay hidden', () => {
  const cfg = readConfig(file('partial.json', JSON.stringify({ claudeApi: { keychain: { service: 's', account: 'a' } } })))
  assert.deepEqual(Object.keys(cfg), ['claudeApi'])
  assert.deepEqual(cfg.claudeApi, { keychain: { service: 's', account: 'a' }, label: 'API' })
  assert.deepEqual(parseConfig({ vertexSpend: null, agents: undefined }), {})
})

test('a malformed section is "config inválida" for that row only', () => {
  const cfg = parseConfig({ vertexSpend: { project: 'p' }, claudeApi: { keychain: { service: 's', account: 'a' } }, agents: { command: 'ls' } })
  assert.deepEqual(cfg.vertexSpend, { error: INVALID })
  assert.deepEqual(cfg.agents, { error: INVALID })
  assert.equal(cfg.claudeApi.error, undefined)
  assert.equal(INVALID, 'config inválida')
})

test('vertexSpend needs project, ISO currency, positive prices and a credential source', () => {
  assert.deepEqual(validateVertexSpend(VERTEX), {
    project: 'p', currency: 'BRL', inputPricePerToken: { m: 1e-6 }, keychain: { service: 's', account: 'a' },
    tokenFromGcloud: false, label: 'Vertex', priceSource: null
  })
  assert.equal(validateVertexSpend({ ...VERTEX, keychain: undefined, tokenFromGcloud: true }).tokenFromGcloud, true)
  assert.equal(validateVertexSpend({ ...VERTEX, label: 'Gemini' }).label, 'Gemini')
  const broken = [
    { ...VERTEX, project: '' }, { ...VERTEX, currency: 'real' }, { ...VERTEX, inputPricePerToken: {} },
    { ...VERTEX, inputPricePerToken: { m: -1 } }, { ...VERTEX, inputPricePerToken: { m: '1e-6' } },
    { ...VERTEX, keychain: { service: 's' } }, { ...VERTEX, keychain: undefined }, { ...VERTEX, label: 3 }, 'x', []
  ]
  for (const v of broken) assert.deepEqual(validateVertexSpend(v), { error: INVALID }, JSON.stringify(v))
})

test('claudeApi needs a Keychain item', () => {
  for (const v of [{}, { keychain: {} }, { keychain: { service: 's', account: '' } }, null, 'x']) {
    assert.deepEqual(validateClaudeApi(v), { error: INVALID })
  }
})

test('agents needs an argv; title, refresh and role labels have defaults', () => {
  assert.deepEqual(validateAgents({ command: ['my-agents', '--json'] }),
    { title: 'AGENTES', command: ['my-agents', '--json'], refreshSeconds: 20, roleLabels: {} })
  assert.deepEqual(validateAgents({ title: 'WORKERS', command: ['x'], refreshSeconds: 5, roleLabels: { arq: 'arquiteto' } }),
    { title: 'WORKERS', command: ['x'], refreshSeconds: 5, roleLabels: { arq: 'arquiteto' } })
  for (const v of [{ command: [] }, { command: 'x' }, { command: ['x', 3] }, { command: ['x'], refreshSeconds: 0 },
    { command: ['x'], title: '' }, { command: ['x'], roleLabels: { a: 1 } }]) {
    assert.deepEqual(validateAgents(v), { error: INVALID }, JSON.stringify(v))
  }
})

test('an edit to the file is picked up without a reload', () => {
  const path = file('live.json', '{}')
  assert.deepEqual(readConfig(path), {})
  writeFileSync(path, JSON.stringify({ agents: { command: ['x'], title: 'LIVE' } }))
  assert.equal(readConfig(path).agents.title, 'LIVE')
})

test('the shipped example is itself a valid, complete config', () => {
  const example = JSON.parse(readFileSync(new URL('../tui-sidebar.example.json', import.meta.url), 'utf8'))
  const cfg = parseConfig(example)
  assert.deepEqual(Object.keys(cfg).sort(), ['agents', 'claudeApi', 'vertexSpend'])
  for (const section of Object.values(cfg)) assert.equal(section.error, undefined)
})
