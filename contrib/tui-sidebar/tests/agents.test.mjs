import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fetchAgents, formatElapsed, parseAgents } from '../tui-widgets/lib/agents.mjs'

test('agents keep role, task, start and liveness; malformed rows are dropped, never invented', () => {
  const doc = { agents: [
    { role: 'dev', card: 'TASK-581', title: 'Map', since: 100, seconds: 5, alive: true, stale: false },
    { role: 'review', card: 'TASK-599', since: 200, alive: false, stale: true },
    { role: 'dev', since: 300 },
    { role: 'pm', card: 'TASK-1', since: 'x' }
  ] }
  assert.deepEqual(parseAgents(doc).agents.map(a => [a.role, a.card, a.since, a.alive, a.stale]),
    [['dev', 'TASK-581', 100, true, false], ['review', 'TASK-599', 200, false, true]])
  assert.equal(parseAgents({ agents: [{ role: 'dev', card: 'T', since: 1 }] }).agents[0].alive, null, 'unknown liveness stays unknown')
  assert.equal(parseAgents({}).agents, null)
  assert.deepEqual(parseAgents({ agents: [] }).agents, [])
})

test('a failed read is unavailable, not "no agents running"', async () => {
  assert.equal((await fetchAgents(['x'], (_c, _a, _o, cb) => cb(new Error('no registry'), ''))).agents, null)
  assert.equal((await fetchAgents(['x'], (_c, _a, _o, cb) => cb(null, 'not json'))).agents, null)
})

test('the configured argv runs without a shell and with a bounded timeout', async () => {
  await fetchAgents(['python3', '-B', '/opt/agents.py', '--json'], (cmd, args, opts, cb) => {
    assert.equal(cmd, 'python3')
    assert.deepEqual(args, ['-B', '/opt/agents.py', '--json'])
    assert.equal(opts.timeout, 15000)
    assert.equal(opts.shell, undefined)
    cb(null, '{"agents": []}')
  })
})

test('command contract end to end: a real executable printing the documented JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-sidebar-agents-'))
  const ok = join(dir, 'agents-ok')
  writeFileSync(ok, '#!/bin/sh\necho \'{"agents":[{"role":"dev","card":"T-1","since":1700000000,"seconds":9,"alive":false,"stale":true}]}\'\n')
  const fail = join(dir, 'agents-fail')
  writeFileSync(fail, '#!/bin/sh\necho \'{"agents":[]}\'\nexit 3\n')
  chmodSync(ok, 0o755)
  chmodSync(fail, 0o755)
  assert.deepEqual((await fetchAgents([ok])).agents, [{ role: 'dev', card: 'T-1', title: null, since: 1700000000, alive: false, stale: true }])
  assert.equal((await fetchAgents([fail])).agents, null, 'a non-zero exit is unavailable even with valid output')
  assert.equal((await fetchAgents([join(dir, 'missing')])).agents, null)
})

test('time on the task reads compactly from seconds to days', () => {
  assert.equal(formatElapsed(1000, 1042), '42s')
  assert.equal(formatElapsed(1000, 1000 + 48 * 60 + 5), '48m')
  assert.equal(formatElapsed(1000, 1000 + 3 * 3600 + 5 * 60), '3h05')
  assert.equal(formatElapsed(1000, 1000 + 26 * 3600), '1d02h')
  assert.equal(formatElapsed(2000, 1000), '0s')
})
