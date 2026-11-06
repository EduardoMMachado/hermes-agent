import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createSlashHandler } from '../app/createSlashHandler.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import { GatewayClient } from '../gatewayClient.js'

const info = { model: 'test', skills: {}, tools: {}, execution_epoch: '1', execution_generation: 4 }

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0)
}

function harness(canonical = true) {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void

  const result = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })

  const request = vi.fn(async (method: string) => {
    if (method === 'session.resume') {
      return { revision: 8, execution_generation: 4, info: { ...info, execution_generation: 5 }, messages: [] }
    }

    if (method === 'session.mutate' || method === 'session.compress') {
      return result
    }

    return {}
  })

  const sys = vi.fn()
  const setHistoryItems = vi.fn()

  const ctx = {
    slashFlightRef: { current: 0 },
    gateway: { gw: { isCanonical: canonical, request }, rpc: request },
    transcript: { sys, setHistoryItems },
    local: { maybeWarn: vi.fn() },
    session: { resumeById: vi.fn() },
    composer: { enqueue: vi.fn() }
  }

  return { slash: createSlashHandler(ctx as any), request, sys, setHistoryItems, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetUiState()
  patchUiState({ sid: 'owner', info })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

for (const canonical of [true, false]) {
  it(`immediately reports manual compression, elapsed wait and rejects duplicates (${canonical ? 'canonical' : 'legacy'})`, async () => {
    const h = harness(canonical)
    h.slash('/compress')
    expect(h.sys).toHaveBeenCalledWith(expect.stringMatching(/compress.*waiting/i))
    await flush()
    await vi.advanceTimersByTimeAsync(125_000)
    expect(h.sys).toHaveBeenCalledWith(expect.stringMatching(/120s/))
    h.slash('/compress different focus')
    await flush()
    expect(h.request.mock.calls.filter(([m]) => ['session.compress', 'session.mutate'].includes(m))).toHaveLength(1)
    h.resolve({ info, execution_generation: 5, summary: { headline: 'Compressed: 20 → 4 messages' } })
    await flush()
    expect(h.sys).toHaveBeenCalledWith('✓ Compressed: 20 → 4 messages')
    const count = h.sys.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sys).toHaveBeenCalledTimes(count)
  })

  it(`does not paint a late result or error after navigation (${canonical})`, async () => {
    for (const fail of [false, true]) {
      patchUiState({ sid: 'owner', info })
      const h = harness(canonical)
      h.slash('/compress')
      await flush()
      patchUiState({ sid: 'other' })
      const count = h.sys.mock.calls.length
      await vi.advanceTimersByTimeAsync(130_000)
      fail
        ? h.reject(new Error('socket closed'))
        : h.resolve({ execution_generation: 5, messages: [], summary: { headline: 'late' } })
      await flush()
      expect(h.setHistoryItems).not.toHaveBeenCalled()
      expect(h.sys).toHaveBeenCalledTimes(count)
    }
  })
}

it('reports definitive failure without success, clears waiting and allows a fresh invocation', async () => {
  const h = harness()
  h.slash('/compress')
  await flush()
  h.reject(Object.assign(new Error('summary refused'), { data: { reason: 'summary_failed' } }))
  await flush()
  expect(h.sys).toHaveBeenCalledWith(expect.stringContaining('summary refused'))
  expect(h.setHistoryItems).not.toHaveBeenCalled()
  const count = h.sys.mock.calls.length
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.sys).toHaveBeenCalledTimes(count)
  h.slash('/compress')
  await flush()
  expect(h.request.mock.calls.filter(([m]) => m === 'session.mutate')).toHaveLength(2)
})

it('a lost legacy reply is not retried or reported as cancelled, and unrelated sessions remain usable', async () => {
  const h = harness(false)
  h.slash('/compress')
  await flush()
  await vi.advanceTimersByTimeAsync(125_000)
  h.reject(new Error('request timed out after 660s: session.compress'))
  await flush()
  expect(h.sys).toHaveBeenCalledWith(expect.stringMatching(/may still be running; it was not cancelled/))
  h.slash('/compress')
  await flush()
  expect(h.request.mock.calls.filter(([method]) => method === 'session.compress')).toHaveLength(1)
  patchUiState({ sid: 'unrelated' })
  h.slash('/compress')
  await flush()
  expect(h.request.mock.calls.filter(([method]) => method === 'session.compress')).toHaveLength(2)
})

it('canonical explicit lost-reply retry reuses the exact mutation receipt, never auto-retries', async () => {
  const h = harness()
  h.slash('/compress focus')
  await flush()
  h.reject(new Error('connection lost'))
  await flush()
  await vi.advanceTimersByTimeAsync(660_000)
  expect(h.request.mock.calls.filter(([method]) => method === 'session.mutate')).toHaveLength(1)
  h.slash('/compress focus')
  await flush()
  const calls = h.request.mock.calls.filter(([method]) => method === 'session.mutate')
  expect(calls).toHaveLength(2)
  expect(calls[0]).toEqual(calls[1])
})

it('profile changes suppress late compression results and do not share duplicate claims', async () => {
  const h = harness()
  h.slash('/compress')
  await flush()
  patchUiState({ info: { ...info, profile_name: 'other-profile' } })
  const count = h.sys.mock.calls.length
  h.resolve({ execution_generation: 5, summary: { headline: 'must not paint' } })
  await flush()
  expect(h.sys).toHaveBeenCalledTimes(count)
  expect(h.setHistoryItems).not.toHaveBeenCalled()
  h.slash('/compress')
  await flush()
  expect(h.request.mock.calls.filter(([method]) => method === 'session.mutate')).toHaveLength(2)
})

it('legacy pending, preview, lock-held and aborted replies never fabricate successful compression', async () => {
  for (const result of [
    { status: 'pending', message: 'still running on host' },
    { status: 'preview', host_ack: { output: 'preview only' } },
    { compressed: false, message: 'lock held elsewhere' },
    { status: 'aborted', summary: { aborted: true, headline: 'aborted without changes' } }
  ]) {
    const h = harness(false)
    h.slash('/compress')
    await flush()
    h.resolve({ ...result, messages: [{ role: 'assistant', text: 'must not apply' }] })
    await flush()
    expect(h.setHistoryItems).not.toHaveBeenCalled()
    expect(h.sys.mock.calls.some(([text]) => text.startsWith('✓'))).toBe(false)

    if (result.status === 'pending') {
      h.slash('/compress')
      await flush()
      expect(h.request.mock.calls.filter(([method]) => method === 'session.compress')).toHaveLength(1)
      expect(h.sys).toHaveBeenCalledWith('still running on host')
    }
  }
})

class Socket extends EventTarget {
  static current: Socket
  readyState = 0
  sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  constructor() {
    super()
    Socket.current = this
  }
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  reply(frame: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
}

it('real client/channel waits past 120s for both compression wires, bounds stalled requests at 660s, ordinary RPC unchanged', async () => {
  vi.stubEnv('HERMES_TUI_GATEWAY_URL', 'ws://isolated-test')
  vi.stubGlobal('WebSocket', Socket)
  const client = new GatewayClient()
  client.start()
  const socket = Socket.current
  socket.open()

  for (const [method, params] of [
    ['session.compress', { session_id: 'owner' }],
    ['session.mutate', { session_id: 'owner', operation: 'compress' }]
  ] as const) {
    client.isCanonical = method === 'session.mutate'
    const success = client.request(method, params)
    const observed = success.catch(error => error)
    await flush()
    const id = socket.sent.at(-1)!.id
    await vi.advanceTimersByTimeAsync(125_000)
    socket.reply({ jsonrpc: '2.0', id, result: { status: 'noop' } })
    expect(await observed).toEqual({ status: 'noop' })
  }

  const ordinary = client.request('session.info', { session_id: 'other' }).catch(error => error)
  const stalled = client.request('session.compress', { session_id: 'owner' }).catch(error => error)
  await flush()
  const id = socket.sent.at(-1)!.id
  await vi.advanceTimersByTimeAsync(120_000)
  expect((await ordinary).message).toMatch(/120s/)
  await vi.advanceTimersByTimeAsync(540_000)
  expect((await stalled).message).toMatch(/660s/)
  expect((await stalled).message).toMatch(/may still be running/i)
  socket.reply({ jsonrpc: '2.0', id, result: { removed: 20 } })
  expect(await stalled).toBeInstanceOf(Error)
  client.kill('isolated test complete')
})
