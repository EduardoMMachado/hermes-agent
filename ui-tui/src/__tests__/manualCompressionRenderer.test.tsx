import { PassThrough } from 'node:stream'

import { Box, renderSync } from '@hermes/ink'
import { stripAnsi } from '@hermes/shared/ansi'
import React, { useState } from 'react'
import { expect, it, vi } from 'vitest'

import { createSlashHandler } from '../app/createSlashHandler.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import { MessageLine } from '../components/messageLine.js'
import { GatewayClient } from '../gatewayClient.js'
import { DEFAULT_THEME } from '../theme.js'

class Socket extends EventTarget {
  static current: Socket
  readyState = 0
  sent: Array<{ id: string; method: string }> = []
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
  reply(id: string, result: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) }))
  }
}

it('renders immediate and elapsed waiting through the slash handler, real client/channel and candidate Ink; late success paints once', async () => {
  vi.useFakeTimers()
  vi.stubEnv('HERMES_TUI_GATEWAY_URL', 'ws://isolated-render')
  vi.stubGlobal('WebSocket', Socket)
  resetUiState()
  patchUiState({ sid: 'render-owner' })
  const gw = new GatewayClient()
  gw.start()
  Socket.current.open()
  let output = ''
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: false })
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  let slash!: ReturnType<typeof createSlashHandler>
  const slashFlightRef = { current: 0 }

  function Screen() {
    const [lines, setLines] = useState<string[]>([])
    slash = createSlashHandler({
      gateway: { gw, rpc: gw.request.bind(gw) },
      local: {},
      slashFlightRef,
      transcript: { sys: (text: string) => setLines(current => [...current, text]), setHistoryItems: vi.fn() }
    } as any)

    return (
      <Box flexDirection="column">
        {lines.map((text, index) => (
          <MessageLine cols={120} key={index} msg={{ role: 'system', text }} t={DEFAULT_THEME} />
        ))}
      </Box>
    )
  }

  const screen = renderSync(<Screen />, {
    stdin: new PassThrough() as any,
    stdout: stdout as any,
    stderr: new PassThrough() as any,
    patchConsole: false
  })

  try {
    slash('/compress')
    await vi.advanceTimersByTimeAsync(0)
    expect(stripAnsi(output)).toContain('compress — waiting for gateway result · 0s elapsed')
    await vi.advanceTimersByTimeAsync(125_000)
    expect(stripAnsi(output)).toContain('120s elapsed')
    slash('/compress duplicate')
    await vi.advanceTimersByTimeAsync(0)
    const calls = Socket.current.sent.filter(frame => frame.method === 'session.compress')
    expect(calls).toHaveLength(1)
    Socket.current.reply(calls[0]!.id, { summary: { headline: 'Compressed: 20 → 4 messages' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(stripAnsi(output)).toContain('✓ Compressed: 20 → 4 messages')
    const count = Socket.current.sent.length
    await vi.advanceTimersByTimeAsync(660_000)
    expect(Socket.current.sent).toHaveLength(count)
  } finally {
    screen.unmount()
    screen.cleanup()
    gw.kill('isolated render complete')
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetUiState()
  }
})
