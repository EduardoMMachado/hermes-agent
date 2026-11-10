import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROLE, SCRIPT, fetchAgents, onCard, parseAgents } from '../tui-widgets/lib/pipeline.mjs'

test('agents keep role, card, start and liveness; malformed rows are dropped, never invented', () => {
  const doc = { agents: [
    { role: 'dev', card: 'PRD-581', title: 'Map', since: 100, alive: true, stale: false },
    { role: 'revisor', card: 'PRD-599', since: 200, alive: false, stale: true },
    { role: 'dev', since: 300 },
    { role: 'pm', card: 'PRD-1', since: 'x' }
  ] }
  assert.deepEqual(parseAgents(doc).agents.map(a => [a.role, a.card, a.since, a.alive, a.stale]),
    [['dev', 'PRD-581', 100, true, false], ['revisor', 'PRD-599', 200, false, true]])
  assert.equal(parseAgents({}).agents, null)
  assert.deepEqual(parseAgents({ agents: [] }).agents, [])
})

test('a failed read is unavailable, not "no agents running"', async () => {
  assert.equal((await fetchAgents((_c, _a, _o, cb) => cb(new Error('no registry'), ''))).agents, null)
  assert.equal((await fetchAgents((_c, _a, _o, cb) => cb(null, 'not json'))).agents, null)
})

test('the poll runs the read-only brain script with a bounded timeout', async () => {
  await fetchAgents((cmd, args, opts, cb) => {
    assert.equal(cmd, 'python3')
    assert.deepEqual(args, ['-B', SCRIPT, '--json'])
    assert.match(SCRIPT, /emana-brain\/scripts\/despachante\/pipeline_agents\.py$/)
    assert.equal(opts.timeout, 15000)
    cb(null, '{"agents": []}')
  })
})

test('time on the card reads compactly from seconds to days', () => {
  assert.equal(onCard(1000, 1042), '42s')
  assert.equal(onCard(1000, 1000 + 48 * 60 + 5), '48m')
  assert.equal(onCard(1000, 1000 + 3 * 3600 + 5 * 60), '3h05')
  assert.equal(onCard(1000, 1000 + 26 * 3600), '1d02h')
  assert.equal(onCard(2000, 1000), '0s')
  assert.equal(ROLE.arq, 'arquiteto')
})
