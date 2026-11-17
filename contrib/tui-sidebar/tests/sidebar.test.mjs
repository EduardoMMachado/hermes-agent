// Renders the side bar with a fake widget SDK (no TUI, no subprocess: effects never run) and checks which
// optional rows exist for a given tui-sidebar.json. The real headless render lives in the TUI's own tests.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'tui-sidebar-home-'))
mkdirSync(join(home, 'state'))
process.env.HERMES_HOME = home
const CONFIG = join(home, 'tui-sidebar.json')

const React = {
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null })
}
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
let app
const sdk = {
  Box: 'Box', Text: 'Text', React, h,
  defineWidgetApp: spec => spec,
  openWidget: spec => { app = spec },
  useSessionInfo: () => ({ sid: null }),
  runSlash: () => {}
}

function text(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  const { type, props } = node
  if (typeof type === 'function') return text(type({ ...props, children: props.children }))
  const parts = props.children.flat().map(text)
  return type === 'Box' && props.flexDirection !== 'row' ? parts.filter(Boolean).join('\n') : parts.join('')
}

const { default: register } = await import('../tui-widgets/sidebar.mjs')
register(sdk)
const t = { color: new Proxy({}, { get: () => '#888888' }) }
const render = () => text(app.render({ t, rows: 60 }))

test('without tui-sidebar.json every optional row is hidden and the rest still renders', () => {
  rmSync(CONFIG, { force: true })
  const screen = render()
  for (const always of ['EXPLORADOR', 'SESSÕES', 'AGENDADOS', 'CONSUMO DE LLM', 'Claude', 'Codex', '/sessions']) {
    assert.ok(screen.includes(always), always)
  }
  for (const optional of ['Vertex', 'Gemini', 'AGENTES', 'PIPELINE', 'Claude API', 'config inválida']) {
    assert.ok(!screen.includes(optional), optional)
  }
})

test('an unreadable config hides the optional rows, never crashes', () => {
  writeFileSync(CONFIG, '{ this is not json')
  const screen = render()
  assert.ok(screen.includes('CONSUMO DE LLM'))
  assert.ok(!screen.includes('AGENTES') && !screen.includes('Vertex'))
})

test('configured sections appear with their own labels and title', () => {
  writeFileSync(CONFIG, JSON.stringify({
    vertexSpend: { label: 'Gemini', project: 'p', currency: 'BRL', inputPricePerToken: { m: 1e-6 }, tokenFromGcloud: true },
    claudeApi: { label: 'API', keychain: { service: 's', account: 'a' } },
    agents: { title: 'WORKERS', command: ['true'] }
  }))
  const screen = render()
  assert.match(screen, /Gemini\s+— em mês/)
  assert.match(screen, /API\s+— em mês/)
  assert.ok(screen.includes('WORKERS'))
  assert.ok(screen.includes('carregando…'), 'agents start loading, not "none running"')
})

test('a malformed section says so on its own row only', () => {
  writeFileSync(CONFIG, JSON.stringify({ vertexSpend: { project: 'p' }, agents: { command: [] }, claudeApi: { keychain: { service: 's', account: 'a' } } }))
  const screen = render()
  assert.ok(screen.includes('vertexSpend: config inválida'))
  assert.ok(screen.includes('agents: config inválida'))
  assert.match(screen, /API\s+— em mês/)
})
