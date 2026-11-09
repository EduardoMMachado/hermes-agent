import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute } from 'node:path'

import { renderSync, useInput, useSelection } from '@hermes/ink'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { GatewayProvider } from '../src/app/gatewayContext.js'
import { getInputSelection } from '../src/app/inputSelectionStore.js'
import { scrollWithSelectionBy } from '../src/app/scroll.js'
import { patchTurnState } from '../src/app/turnStore.js'
import { patchUiState } from '../src/app/uiStore.js'
import { useComposerState } from '../src/app/useComposerState.js'
import { useInputHandlers } from '../src/app/useInputHandlers.js'
import { AppLayout } from '../src/components/appLayout.js'
import { toTranscriptMessages } from '../src/domain/messages.js'
import { useVirtualHistory } from '../src/hooks/useVirtualHistory.js'
import { DEFAULT_VOICE_RECORD_KEY } from '../src/lib/platform.js'
import { buildVerboseToolTrailLine } from '../src/lib/text.js'
import { estimatedMsgHeight } from '../src/lib/virtualHeights.js'

const socketPath = process.env.PROBE_SOCKET

if (!socketPath || !isAbsolute(socketPath) || !process.stdin.isTTY || !process.stdout.isTTY || !process.env.HERMES_HOME) {
  throw new Error('Synthetic fixture requires an absolute PROBE_SOCKET, isolated HERMES_HOME and real PTY input/output.')
}

const clock = process.env.PROBE_CLOCK
  ? (await import(process.env.PROBE_CLOCK)).default.install({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
  : null

const decoded: Array<{ raw: string; at: number }> = []

const noop = () => {}
const cols = process.stdout.columns
const nativeMode = process.env.HERMES_TUI_NATIVE === '1'
const changes: string[] = []
const submitted: string[] = []
const renderFrames: any[] = []
let draft = ''
let replace: (s: string) => void = noop
let scroll: any = null
let range: any = null
let sticky = ''
const gw = { isCanonical: true, request: async () => ({ items: [], queued: [] }), on: noop, off: noop }

const baseStatus = {
  cwdLabel: 'synthetic',
  goodVibesTick: 0,
  lastTurnEndedAt: null,
  sessionStartedAt: null,
  sessionTitle: 'Synthetic Pipeline',
  statusColor: '#808080',
  turnStartedAt: null,
  voiceLabel: ''
}

function syntheticHistory() {
  if (process.env.PROBE_SHAPE) {
    const rows = JSON.parse(readFileSync(process.env.PROBE_SHAPE, 'utf8'))

    if (process.env.PROBE_SHAPE_RESUME) {return toTranscriptMessages(rows)}

    // Live-like persisted trails use the same bounded production builder.
    // These are synthetic payloads, not a replay of original Pipeline output.
    return rows.flatMap((row: any) =>
      row.role === 'tool'
        ? [
            {
              role: 'assistant',
              kind: 'trail',
              text: '',
              tools: [
                buildVerboseToolTrailLine(
                  row.name ?? 'tool',
                  row.context,
                  false,
                  0.1,
                  row.context,
                  row.synthetic_result
                )
              ]
            }
          ]
        : toTranscriptMessages([row])
    )
  }

  if (!process.env.PROBE_LONG) {return [{ role: 'user', text: 'Synthetic streaming integration request' }]}
  const lengths = Array.from({ length: 310 }, (_, i) => (i === 155 ? 53104 : Math.floor((280511 - 53104) / 309)))
  lengths[0] += 280511 - lengths.reduce((a, b) => a + b, 0)

  return lengths.map((length, i) => {
    const seed = `${i % 8 === 0 ? 'Request' : 'Response'} ${i}: synthetic markdown **bold**, inline code and paragraph.\n`

    return {
      role: i % 8 === 0 ? 'user' : 'assistant',
      text: seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
    }
  })
}

const historyItems = syntheticHistory() as any
const virtualRows = historyItems.map((msg: any, index: number) => ({ key: `synthetic-${index}`, index, msg }))
const progress = { showProgressArea: true }
patchUiState({ busy: true, sid: 'synthetic-pty', statusBar: 'off', info: null })

function Fixture() {
  useInput((_, __, event) => {
    decoded.push({ raw: event.keypress.raw, at: performance.now() })
  })
  const submitRef = useRef(noop)
  const scrollRef = useRef(null)
  const selection = useSelection()
  const [stickyPrompt, setStickyPrompt] = useState('')
  sticky = stickyPrompt

  const actions = useMemo(
    () =>
      new Proxy({ setStickyPrompt }, { get: (o, k) => (k === 'setStickyPrompt' ? o.setStickyPrompt : noop) }) as any,
    []
  )

  const c = useComposerState({ gw: gw as any, submitRef, sys: noop })

  const virtualHistory = useVirtualHistory(scrollRef, virtualRows, cols, {
    nativeMode,
    liveTailActive: true,
    estimateHeight: i => estimatedMsgHeight(virtualRows[i].msg, cols, { compact: false, details: true })
  })

  scroll = scrollRef
  range = { start: virtualHistory.start, end: virtualHistory.end, total: historyItems.length }
  useInputHandlers({
    actions,
    composer: c,
    gateway: { gw, rpc: gw.request },
    terminal: {
      scrollRef,
      selection,
      stdout: process.stdout,
      hasSelection: false,
      scrollWithSelection: (delta: number) => scrollWithSelectionBy(delta, { scrollRef, selection })
    },
    voice: {
      enabled: false,
      recording: false,
      recordKey: DEFAULT_VOICE_RECORD_KEY,
      setProcessing: noop,
      setRecording: noop,
      setVoiceEnabled: noop,
      setVoiceTts: noop
    },
    wheelStep: 3
  } as any)
  draft = c.state.input
  replace = c.actions.setInput

  const updateInput = useCallback(
    (value: string) => {
      changes.push(value)
      c.actions.syncTokens(value)
      c.actions.setInput(value)
    },
    [c.actions]
  )

  const submit = useCallback(
    (value: string) => {
      submitted.push(value)
      c.actions.clearIn()
    },
    [c.actions]
  )

  const composer = useMemo(
    () => ({
      cols,
      compIdx: c.state.compIdx,
      completions: c.state.completions,
      empty: false,
      handleTextPaste: c.actions.handleTextPaste,
      input: c.state.input,
      inputBuf: c.state.inputBuf,
      pagerPageSize: Math.max(5, process.stdout.rows - 6),
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
      mouseTracking="all"
      progress={progress}
      status={{ ...baseStatus, showStickyPrompt: !!stickyPrompt, stickyPrompt }}
      transcript={{ historyItems, virtualRows, virtualHistory, scrollRef }}
    />
  )
}

const instance = renderSync(
  <GatewayProvider value={{ gw } as any}>
    <Fixture />
  </GatewayProvider>,
  { patchConsole: false, exitOnCtrlC: false, onFrame: frame => renderFrames.push({ at: performance.now(), ...frame }) }
)

let delta = 0

const server = createServer(socket => {
  let pending = ''
  socket.on('data', chunk => {
    pending += chunk

    while (pending.includes('\n')) {
      const i = pending.indexOf('\n')
      const line = pending.slice(0, i)
      pending = pending.slice(i + 1)
      const cmd = JSON.parse(line)

      if (cmd.op === 'stream') {
        delta++
        patchTurnState({ streaming: `Streaming ${delta}: ${'synthetic response '.repeat(20 + (delta % 12))}` })
      }

      if (cmd.op === 'advance') {clock?.tick(cmd.ms)}

      if (cmd.op === 'replace') {replace(cmd.value)}

      if (cmd.op === 'quit') {
        instance.unmount()
        instance.cleanup()
        server.close()
        process.exit(0)
      }

      setImmediate(() =>
        setImmediate(() => {
          const selection = getInputSelection()
          const s = scroll?.current
          socket.write(
            JSON.stringify({
              draft,
              decoded,
              changes,
              submitted,
              range,
              historyShape: {
                messages: historyItems.length,
                chars: historyItems.reduce((n: number, msg: any) => n + msg.text.length, 0),
                toolTrails: historyItems.filter((msg: any) => msg.tools?.length).length
              },
              sticky,
              renderFrames: renderFrames.slice(-5),
              renderFrameCount: renderFrames.length,
              scroll: s && {
                top: s.getScrollTop(),
                pending: s.getPendingDelta(),
                sticky: s.isSticky(),
                height: s.getScrollHeight(),
                viewport: s.getViewportHeight()
              },
              selection: selection && { value: selection.value, cursor: selection.cursor }
            }) + '\n'
          )
        })
      )
    }
  })
})

server.listen(socketPath)
