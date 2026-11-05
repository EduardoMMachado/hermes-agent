import type { GatewayEvent } from '@hermes/shared/gateway-events'

import { toTranscriptMessages } from '../domain/messages.js'
import type { Msg, SessionInfo } from '../types.js'

export type PendingRow = NonNullable<SessionInfo['pending_submissions']>[number]

// Inputs whose transcript bubble this client already painted at submit time.
// A busy-time admission defers its bubble until the authority starts it, so
// the bubble lands after the in-flight assistant reply instead of inside it.
const shown = new Set<string>()
let startedMessage: GatewayEvent<'message.start'> | undefined

export const markBubbleShown = (inputId?: string) => { if (inputId) { shown.add(inputId) } }

export const resetBubbleLedger = () => { shown.clear(); startedMessage = undefined }

export const rememberBubbleStart = (event: GatewayEvent<'message.start'>) => { startedMessage = event }

// Rows the authority just moved queued → started whose bubble nobody painted.
// Only a transition observed by THIS client counts: a resume snapshot's started
// row already lives in the replayed history.
export function newlyStartedRows(previous: PendingRow[] | undefined, incoming: PendingRow[] | undefined): PendingRow[] {
  if (!previous || !incoming) { return [] }
  const wasQueued = new Set(previous.filter(row => row.status === 'queued').map(row => row.admission_id))

  return incoming.filter(row => row.status === 'started' && wasQueued.has(row.admission_id) && !(row.input_id && shown.has(row.input_id)))
}

export const isServerQueued = (row: PendingRow) => row.status === 'queued' || row.status === 'unknown'

export function startedBubbleMessages(row: PendingRow, sessionId: null | string): Msg[] {
  // Transport role does not establish human authorship. Only the owner's
  // display metadata for this exact admission can classify an automated turn.
  // Keep it with the bubble ledger: React can recreate the handler between frames.
  const display = startedMessage?.session_id === sessionId && startedMessage?.admission_id === row.admission_id
    ? startedMessage.payload : undefined

  return toTranscriptMessages([{
    role: 'user', text: row.user,
    display_kind: display?.notification_category === 'diagnostic' ? 'hidden' : display?.display_kind,
    display_metadata: { display_text: display?.display_text }
  }])
}
