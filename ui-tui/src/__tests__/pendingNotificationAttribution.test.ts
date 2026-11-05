import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGatewayEventHandler } from '../app/createGatewayEventHandler.js'
import { resetBubbleLedger } from '../app/pendingBubbles.js'
import { turnController } from '../app/turnController.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import { canonicalEvent } from '../canonicalGateway.js'
import { toTranscriptMessages } from '../domain/messages.js'
import { stickyPromptFromViewport } from '../domain/viewport.js'
import type { Msg } from '../types.js'

const notification = '[ASYNC DELEGATION COMPLETE — background result, not a human request]'

const pending = (id: string, text: string, status = 'queued') => ({
  admission_id: id, input_id: `input-${id}`, text, status,
  ref: { profile_id: '/isolated-test-profile', session_id: 'owner' }
})

function harness() {
  const messages: Msg[] = [{ role: 'user', text: 'The real human request' }]
  const noop = vi.fn()

  const onEvent = createGatewayEventHandler({
    composer: { dequeue: () => undefined, queueEditRef: { current: null }, sendQueued: noop, setInput: noop },
    gateway: { gw: { request: vi.fn(async () => null) }, rpc: vi.fn(async () => null) },
    session: { STARTUP_RESUME_ID: '', colsRef: { current: 80 }, newSession: noop, resetSession: noop,
      resumeById: noop, setCatalog: noop },
    submission: { submitRef: { current: noop } },
    system: { bellOnComplete: false, sys: noop },
    transcript: { appendMessage: (message: Msg) => messages.push(message), panel: noop, setHistoryItems: noop },
    voice: { setProcessing: noop, setRecording: noop, setVoiceEnabled: noop }
  } as any)

  const info = (rows: ReturnType<typeof pending>[]) => onEvent(canonicalEvent({
    type: 'session.info', session_id: 'owner', payload: { pending: rows, running: true }
  } as any))

  const start = (id: string, payload: Record<string, unknown>, sessionId = 'owner') => onEvent({
    type: 'message.start', session_id: sessionId, admission_id: id, payload
  } as any)

  return { messages, info, start }
}

beforeEach(() => {
  turnController.fullReset()
  resetBubbleLedger()
  resetUiState()
  patchUiState({ sid: 'owner' })
})

afterEach(() => {
  turnController.fullReset()
  resetBubbleLedger()
  resetUiState()
})

describe('queued notification authorship', () => {
  it.each(['async_delegation_complete', 'process_complete', 'internal_notification'])(
    'renders %s as a system event without replacing the pinned human request', displayKind => {
      const h = harness()
      h.info([pending('notice', notification)])
      h.start('notice', { display_kind: displayKind, display_text: 'Background work finished', text: notification })
      h.info([pending('notice', notification, 'started')])
      h.info([pending('notice', notification, 'started')])

      expect(h.messages).toEqual([
        { role: 'user', text: 'The real human request' },
        { role: 'system', kind: 'event', text: 'Background work finished' }
      ])
      expect(stickyPromptFromViewport(h.messages, [0, 2, 4], 5, 10, false)).toBe('The real human request')
    }
  )

  it('keeps a genuine human quote of notification text as a human request', () => {
    const h = harness()
    h.info([pending('notice', notification)])
    h.start('notice', { display_kind: 'process_complete', display_text: 'Process finished', text: notification })
    h.info([pending('notice', notification, 'started')])
    h.info([pending('human', notification)])
    h.start('human', {})
    h.info([pending('human', notification, 'started')])

    expect(h.messages.at(-1)).toEqual({ role: 'user', text: notification })
  })

  it('retains internal-notification authorship when history has no producer label', () => {
    const messages = toTranscriptMessages([
      { role: 'user', text: 'A human quoting an internal notice' },
      { role: 'user', text: notification, display_kind: 'internal_notification' }
    ])

    expect(messages).toEqual([
      { role: 'user', text: 'A human quoting an internal notice' },
      { role: 'system', kind: 'event', text: notification }
    ])
  })

  it('does not borrow a notification classification from another admission', () => {
    const h = harness()
    h.info([pending('human', notification)])
    h.start('other', { display_kind: 'process_complete', display_text: 'Unrelated completion' })
    h.info([pending('human', notification, 'started')])

    expect(h.messages.at(-1)).toEqual({ role: 'user', text: notification })
  })

  it('ignores notification display metadata from another session', () => {
    const h = harness()
    h.info([pending('notice', notification)])
    h.start('notice', { display_kind: 'process_complete', display_text: 'Foreign completion' }, 'foreign-session')
    h.info([pending('notice', notification, 'started')])

    expect(h.messages.at(-1)).toEqual({ role: 'user', text: notification })
  })

  it.each([
    { display_kind: 'hidden', display_text: 'Hidden machinery' },
    { display_kind: 'process_complete', display_text: 'Diagnostic', notification_category: 'diagnostic' }
  ])('does not expose hidden or diagnostic machinery as a user bubble: %j', payload => {
    const h = harness()
    h.info([pending('notice', notification)])
    h.start('notice', payload)
    h.info([pending('notice', notification, 'started')])

    expect(h.messages).toEqual([{ role: 'user', text: 'The real human request' }])
  })

  it('does not add a duplicate bubble for an already-started resume snapshot', () => {
    const h = harness()
    h.start('notice', { display_kind: 'process_complete', display_text: 'Already in history' })
    h.info([pending('notice', notification, 'started')])

    expect(h.messages).toEqual([{ role: 'user', text: 'The real human request' }])
  })
})
