import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCRIPT, fetchSpend, formatMonth, formatUsd, parseSpend } from '../tui-widgets/lib/gemini.mjs'

test('the month spend is the estimate emana-brain computed, never invented as zero', async () => {
  assert.deepEqual(parseSpend({ month: '2026-11', usd: 3.4803, runs: 1, unpriced_runs: 0, estimate: true }),
    { usd: 3.4803, month: '2026-11', runs: 1, unpriced: 0 })
  for (const usd of [undefined, null, '3.48', -1, NaN, Infinity]) {
    assert.equal(parseSpend({ month: '2026-11', usd, estimate: true }).usd, null)
  }
  assert.equal(parseSpend({ month: '2026-11', usd: 3 }).usd, null, 'a document not marked as an estimate is refused')
  assert.equal((await fetchSpend((_c, _a, _o, cb) => cb(new Error('no python'), ''))).usd, null)
  assert.equal((await fetchSpend((_c, _a, _o, cb) => cb(null, 'not json'))).usd, null)
})

test('the poll runs the read-only brain script with a bounded timeout', async () => {
  const result = await fetchSpend((cmd, args, opts, cb) => {
    assert.equal(cmd, 'python3')
    assert.deepEqual(args, ['-B', SCRIPT, '--json'])
    assert.match(SCRIPT, /emana-brain\/scripts\/despachante\/gemini_spend\.py$/)
    assert.equal(opts.timeout, 25000)
    cb(null, JSON.stringify({ month: '2026-11', usd: 0, runs: 0, unpriced_runs: 0, estimate: true }))
  })
  assert.equal(result.usd, 0)
})

test('money and month read in Portuguese', () => {
  assert.equal(formatUsd(3.4803).replace(/\s/g, ' '), 'US$ 3,48')
  assert.equal(formatMonth('2026-11'), 'nov/2026')
  assert.equal(formatMonth(null), 'mês')
})
