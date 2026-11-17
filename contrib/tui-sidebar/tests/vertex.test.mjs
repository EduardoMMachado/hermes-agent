import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCRIPT, fetchSpend, formatMoney, formatMonth, parseSpend, scriptArgs } from '../tui-widgets/lib/vertex.mjs'
import { validateVertexSpend } from '../tui-widgets/lib/config.mjs'

const CFG = validateVertexSpend({
  project: 'example-project', currency: 'BRL', inputPricePerToken: { 'gemini-3.8-flash': 9.152e-06 },
  keychain: { service: 'example-vertex-sa', account: 'reader' }
})

test('the month cost is what the script read from Google, never invented as zero', async () => {
  assert.deepEqual(parseSpend({ month: '2026-11', amount: 384.26, currency: 'BRL', unpriced_models: [], estimate: true }),
    { amount: 384.26, currency: 'BRL', month: '2026-11', unpriced: [], error: null })
  for (const amount of [undefined, null, '384', -1, NaN, Infinity]) {
    assert.equal(parseSpend({ month: '2026-11', amount, currency: 'BRL', estimate: true }).amount, null)
  }
  assert.equal(parseSpend({ month: '2026-11', amount: 3, currency: 'BRL' }).amount, null, 'a document not marked as an estimate is refused')
  assert.equal(parseSpend({ month: '2026-11', amount: 3, estimate: true }).amount, null, 'a document without a currency is refused')
  assert.equal((await fetchSpend(CFG, (_c, _a, _o, cb) => cb(null, 'not json'))).amount, null)
})

test('a failed reading keeps its reason even though the script exits non-zero', async () => {
  const r = await fetchSpend(CFG, (_c, _a, _o, cb) => cb(new Error('exit 1'), '{"error": "sem credencial no Keychain", "estimate": true}'))
  assert.deepEqual([r.amount, r.error], [null, 'sem credencial no Keychain'])
  assert.equal((await fetchSpend(CFG, (_c, _a, _o, cb) => cb(new Error('no python'), ''))).error, 'sem leitura')
})

test('the poll runs the bundled read-only script with the configured settings and a bounded timeout', async () => {
  const result = await fetchSpend(CFG, (cmd, args, opts, cb) => {
    assert.equal(cmd, 'python3')
    assert.deepEqual(args, ['-B', SCRIPT, '--json', '--project', 'example-project', '--currency', 'BRL',
      '--price', 'gemini-3.8-flash=0.000009152', '--keychain-service', 'example-vertex-sa', '--keychain-account', 'reader'])
    assert.match(SCRIPT, /contrib\/tui-sidebar\/tui-widgets\/bin\/vertex_spend\.py$/)
    assert.equal(opts.timeout, 25000)
    cb(null, JSON.stringify({ month: '2026-11', amount: 0, currency: 'BRL', unpriced_models: ['gemini-4-argon'], estimate: true }))
  })
  assert.deepEqual([result.amount, result.unpriced], [0, ['gemini-4-argon']])
})

test('without a Keychain item the script uses the gcloud session', () => {
  const cfg = validateVertexSpend({ project: 'p', currency: 'USD', inputPricePerToken: { m: 1e-6 }, tokenFromGcloud: true, priceSource: 'catalog' })
  const args = scriptArgs(cfg)
  assert.ok(args.includes('--token-from-gcloud'))
  assert.ok(!args.includes('--keychain-service'))
  assert.deepEqual(args.slice(-2), ['--price-source', 'catalog'])
})

test('money reads in the configured currency, month in Portuguese', () => {
  assert.equal(formatMoney(384.26, 'BRL').replace(/\s/g, ' '), 'R$ 384,26')
  assert.equal(formatMoney(12.5, 'USD').replace(/\s/g, ' '), 'US$ 12,50')
  assert.equal(formatMoney(3, 'EUR').replace(/\s/g, ' '), '€ 3,00')
  assert.equal(formatMonth('2026-11'), 'nov/2026')
  assert.equal(formatMonth(null), 'mês')
})
