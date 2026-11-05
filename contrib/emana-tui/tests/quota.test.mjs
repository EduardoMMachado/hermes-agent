import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fetchWeekly, weeklyWindow } from '../tui-widgets/lib/quota.mjs'

test('weekly quota is the whole account window, never the short or model-specific one', () => {
  assert.deepEqual(weeklyWindow({ windows: [
    { label: 'Current session', used_percent: 91 },
    { label: 'Sonnet week', used_percent: 95 },
    { label: 'Current week', used_percent: 0.5, resets_at: '2026-11-12T00:00:00Z' }
  ] }), { percent: 0.5, reset: '2026-11-12T00:00:00Z' })
  assert.deepEqual(weeklyWindow({ windows: [{ label: 'Weekly', used_percent: 0 }] }), { percent: 0, reset: null })
})

test('missing and failed quota reads are unavailable, never invented as zero', async () => {
  for (const value of [undefined, null, '18', -1, 101, NaN]) {
    assert.equal(weeklyWindow({ windows: [{ label: 'Weekly', used_percent: value }] }).percent, null)
  }
  assert.equal(weeklyWindow({ windows: [{ label: 'Session', used_percent: 50 }] }).percent, null)
  assert.equal((await fetchWeekly('openai-codex', (_cmd, _args, _opts, cb) => cb(new Error('offline'), ''))).percent, null)
})

test('poll uses the supported CLI with a read-only credential fetch and a bounded timeout', async () => {
  const result = await fetchWeekly('openai-codex', (cmd, args, opts, cb) => {
    assert.equal(cmd, 'hermes')
    assert.deepEqual(args, ['usage', '--provider', 'openai-codex', '--json', '--read-only'])
    assert.equal(opts.timeout, 25000)
    cb(null, JSON.stringify({ windows: [{ label: 'Weekly', used_percent: 37 }] }))
  })
  assert.equal(result.percent, 37)
})
