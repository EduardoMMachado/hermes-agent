import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCRIPT, fetchSpend, formatBrl, formatMonth, parseSpend } from '../tui-widgets/lib/gemini.mjs'

test('the month cost is what emana-brain read from Google, never invented as zero', async () => {
  assert.deepEqual(parseSpend({ month: '2026-11', brl: 384.26, unpriced_models: [], estimate: true }),
    { brl: 384.26, month: '2026-11', unpriced: [], error: null })
  for (const brl of [undefined, null, '384', -1, NaN, Infinity]) {
    assert.equal(parseSpend({ month: '2026-11', brl, estimate: true }).brl, null)
  }
  assert.equal(parseSpend({ month: '2026-11', brl: 3 }).brl, null, 'a document not marked as an estimate is refused')
  assert.equal((await fetchSpend((_c, _a, _o, cb) => cb(null, 'not json'))).brl, null)
})

test('a failed reading keeps its reason even though the script exits non-zero', async () => {
  const r = await fetchSpend((_c, _a, _o, cb) => cb(new Error('exit 1'), '{"error": "sem credencial no Keychain", "estimate": true}'))
  assert.deepEqual([r.brl, r.error], [null, 'sem credencial no Keychain'])
  assert.equal((await fetchSpend((_c, _a, _o, cb) => cb(new Error('no python'), ''))).error, 'sem leitura')
})

test('the poll runs the read-only brain script with a bounded timeout', async () => {
  const result = await fetchSpend((cmd, args, opts, cb) => {
    assert.equal(cmd, 'python3')
    assert.deepEqual(args, ['-B', SCRIPT, '--json'])
    assert.match(SCRIPT, /emana-brain\/scripts\/despachante\/gemini_spend\.py$/)
    assert.equal(opts.timeout, 25000)
    cb(null, JSON.stringify({ month: '2026-11', brl: 0, unpriced_models: ['gemini-4-argon'], estimate: true }))
  })
  assert.deepEqual([result.brl, result.unpriced], [0, ['gemini-4-argon']])
})

test('money and month read in Portuguese', () => {
  assert.equal(formatBrl(384.26).replace(/\s/g, ' '), 'R$ 384,26')
  assert.equal(formatMonth('2026-11'), 'nov/2026')
  assert.equal(formatMonth(null), 'mês')
})
