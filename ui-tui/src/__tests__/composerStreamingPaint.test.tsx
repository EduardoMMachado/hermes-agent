import { EventEmitter } from 'node:events'

import { renderSync } from '@hermes/ink'
import React, { useCallback, useMemo, useRef } from 'react'
import stripAnsi from 'strip-ansi'
import { expect, it, vi } from 'vitest'

import { GatewayProvider } from '../app/gatewayContext.js'
import type { AppLayoutProps, GatewayServices } from '../app/interfaces.js'
import { patchTurnState } from '../app/turnStore.js'
import { patchUiState } from '../app/uiStore.js'
import { useComposerState } from '../app/useComposerState.js'
import { AppLayout } from '../components/appLayout.js'
import type * as ConfigEnv from '../config/env.js'
import { DEFAULT_VOICE_RECORD_KEY } from '../lib/platform.js'

// Main-screen layout can move a memoized composer while only the streaming
// subtree commits. Unlike forceRedraw, this uses the normal incremental output.
vi.mock('../config/env.js', async importOriginal => ({
  ...(await importOriginal<typeof ConfigEnv>()),
  INLINE_MODE: true,
  NATIVE_MODE: true
}))

class FakeTty extends EventEmitter {
  chunks: string[] = []
  columns = 135
  rows = 83
  isTTY = true
  isRaw = false
  private pending: string[] = []
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.pending.shift() ?? null
  }
  send(value: string): void {
    this.pending.push(value)
    this.emit('readable')
  }
  setEncoding(): this {
    return this
  }
  setRawMode(value: boolean): this {
    this.isRaw = value

    return this
  }
  write(value: string | Uint8Array, cb?: () => void): boolean {
    this.chunks.push(String(value))
    cb?.()

    return true
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

const noop = () => {}

it.each([135, 136, 60])('keeps the live draft in a moving memoized composer at width %i', async cols => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
  vi.stubEnv('TERM_PROGRAM', 'WarpTerminal')
  vi.stubEnv('TERM', 'xterm-256color')
  vi.stubEnv('TMUX', '')
  const stdout = new FakeTty()
  stdout.columns = cols
  stdout.rows = cols === 60 ? 24 : 83
  const stdin = new FakeTty()
  const oldTTY = process.stdout.isTTY
  Object.assign(process.stdout, { isTTY: true })
  vi.spyOn(process.stdout, 'write').mockImplementation(value => stdout.write(value))
  let draft = ''
  const submitted: string[] = []
  const gw = { isCanonical: true, request: async () => ({ items: [], queued: [] }), on: noop, off: noop }
  const actions = new Proxy({}, { get: () => noop }) as AppLayoutProps['actions']

  const status: AppLayoutProps['status'] = {
    cwdLabel: 'synthetic',
    goodVibesTick: 0,
    lastTurnEndedAt: null,
    sessionStartedAt: null,
    sessionTitle: 'Synthetic Pipeline',
    showStickyPrompt: false,
    statusColor: '#808080',
    stickyPrompt: '',
    turnStartedAt: null,
    voiceLabel: ''
  }

  const historyItems: AppLayoutProps['transcript']['historyItems'] = [{ role: 'user', text: 'Synthetic request' }]

  const transcript = {
    historyItems,
    scrollRef: { current: null },
    virtualHistory: { start: 0, end: 1, topSpacer: 0, bottomSpacer: 0, offsets: [0, 3], measureRef: () => noop },
    virtualRows: [{ key: 'synthetic', index: 0, msg: historyItems[0] }]
  } as unknown as AppLayoutProps['transcript']

  const progress = { showProgressArea: true }
  patchUiState({ busy: true, sid: 'synthetic-integration', statusBar: 'off', info: null })
  patchTurnState({ streaming: '' })

  function Fixture() {
    const submitRef = useRef(noop)
    const c = useComposerState({ gw: gw as unknown as GatewayServices['gw'], submitRef, sys: noop })
    draft = c.state.input
    const updateInput = useCallback((value: string) => c.actions.setInput(value), [c.actions])

    const submit = useCallback(
      (value: string) => {
        submitted.push(value)
        c.actions.clearIn()
      },
      [c.actions]
    )

    const composer = useMemo<AppLayoutProps['composer']>(
      () => ({
        cols,
        compIdx: c.state.compIdx,
        completions: c.state.completions,
        empty: false,
        handleTextPaste: c.actions.handleTextPaste,
        input: c.state.input,
        inputBuf: c.state.inputBuf,
        pagerPageSize: 12,
        pasteHint: null,
        queueEditIdx: c.state.queueEditIdx,
        queuedDisplay: c.state.queuedDisplay,
        submit,
        updateInput,
        voiceRecordKey: DEFAULT_VOICE_RECORD_KEY
      }),
      [c.state, c.actions, submit, updateInput]
    )

    return (
      <AppLayout
        actions={actions}
        composer={composer}
        mouseTracking="off"
        progress={progress}
        status={status}
        transcript={transcript}
      />
    )
  }

  const instance = renderSync(
    <GatewayProvider value={{ gw } as unknown as GatewayServices}>
      <Fixture />
    </GatewayProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false
    }
  )

  try {
    await tick()
    await tick()
    stdin.send('a')
    vi.advanceTimersByTime(32)
    await tick()
    await tick()
    expect(draft).toBe('a')
    stdout.chunks = []
    stdin.send('b')
    await tick()
    // The bypass must remain immediate, and the parent still batches changes.
    expect(stripAnsi(stdout.chunks.join(''))).toContain('b')
    expect(draft).toBe('a')
    stdout.chunks = []
    patchTurnState({ streaming: `Streaming: ${'synthetic response '.repeat(28)}` })
    await tick()
    await tick()
    const emitted = stripAnsi(stdout.chunks.join(''))
    // A layout-moving repaint emits a new prompt row. The old fast-echoed
    // "ab" can remain stranded higher up, so a whole-screen contains() lies.
    expect(emitted.slice(emitted.lastIndexOf('❯')), emitted).toContain('ab')
    vi.advanceTimersByTime(32)
    await tick()
    await tick()
    expect(draft).toBe('ab')
    stdin.send('\r')
    await tick()
    await tick()
    expect(submitted).toEqual(['ab'])
  } finally {
    instance.unmount()
    instance.cleanup()
    vi.restoreAllMocks()
    Object.assign(process.stdout, { isTTY: oldTTY })
    vi.unstubAllEnvs()
    vi.useRealTimers()
  }
})
