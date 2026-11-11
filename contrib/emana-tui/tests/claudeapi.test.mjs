import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ENDPOINT, KEYCHAIN, fetchCost, formatUsd, monthRange, parseCost, readAdminKey } from '../tui-widgets/lib/claudeapi.mjs'

const NOW = new Date('2026-11-11T18:30:00Z')
const ok = body => async () => ({ ok: true, status: 200, json: async () => body })

test('the month cost is Anthropic\'s post-discount amount, read from cents', async () => {
  const r = await fetchCost({ now: NOW, readKey: async () => 'k', http: ok({
    data: [{ cost: { amount: '41280.000000', list_amount: '51600.000000', currency: 'USD' } }],
    data_refreshed_at: '2026-11-11T16:50:47Z', has_more: false }) })
  assert.deepEqual(r, { usd: 412.8, month: '2026-11', refreshedAt: '2026-11-11T16:50:47Z', error: null })
  assert.equal(parseCost({ data: [], has_more: false }, '2026-11').usd, 0, 'no usage this month reads as a real zero')
})

test('anything that is not a clean reading is never shown as zero', async () => {
  const cases = [
    [{ readKey: async () => null }, 'sem chave admin no Keychain'],
    [{ http: async () => ({ ok: false, status: 401 }) }, 'chave admin recusada'],
    [{ http: async () => ({ ok: false, status: 529 }) }, 'Anthropic indisponível'],
    [{ http: async () => { throw new Error('offline') } }, 'Anthropic indisponível'],
    [{ http: ok({ data: [{ cost: { amount: 'x', currency: 'USD' } }] }) }, 'sem leitura'],
    [{ http: ok({ data: [{ cost: { amount: '5', currency: 'EUR' } }] }) }, 'sem leitura'],
    [{ http: ok({ data: [], has_more: true }) }, 'resposta paginada'],
  ]
  for (const [overrides, reason] of cases) {
    const r = await fetchCost({ now: NOW, readKey: async () => 'k', http: ok({}), ...overrides })
    assert.deepEqual([r.usd, r.error], [null, reason])
  }
})

test('one request for the UTC calendar month, with the admin key only in the header', async () => {
  let seen
  await fetchCost({ now: NOW, readKey: async () => 'sk-ant-admin01-secret', http: async (url, init) => {
    seen = { url, init }
    return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) }
  } })
  assert.equal(seen.url, `${ENDPOINT}?starting_at=2026-11-01T00%3A00%3A00Z`)
  assert.equal(seen.init.headers['x-api-key'], 'sk-ant-admin01-secret')
  assert.equal(seen.init.headers['anthropic-beta'], 'analytics-usage-cost-2026-08-24')
  assert.ok(!seen.url.includes('secret'))
  assert.deepEqual(monthRange(new Date('2026-12-01T01:00:00-03:00')), { start: '2026-12-01T00:00:00Z', month: '2026-12' })
})

test('the key comes from the named login Keychain item', async () => {
  const key = await readAdminKey((cmd, args, _opts, cb) => {
    assert.equal(cmd, 'security')
    assert.deepEqual(args, ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'])
    cb(null, 'sk-ant-admin01-x\n')
  })
  assert.equal(key, 'sk-ant-admin01-x')
  assert.equal(await readAdminKey((_c, _a, _o, cb) => cb(new Error('not found'), '')), null)
  assert.equal(formatUsd(412.8).replace(/\s/g, ' '), 'US$ 412,80')
})
