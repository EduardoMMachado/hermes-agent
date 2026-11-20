import type { GatewayClient } from '../gatewayClient.js'
import type { SessionActiveItem, SessionActiveListResponse, SessionTitleResponse } from '../gatewayTypes.js'
import { asRpcResult } from '../lib/rpc.js'

import { getUiState, patchUiState } from './uiStore.js'

/** The live-session roster the status bar's title and count read: on the shared owner its own
 * `session.list` (live scope); the sidecar's `session.active_list` never holds those sessions. */
export const requestLiveSessions = (gw: Pick<GatewayClient, 'isCanonical' | 'request'>, currentSid: null | string) =>
  gw.isCanonical
    ? gw.request<SessionActiveListResponse>('session.list', { limit: 200 })
    : gw.request<SessionActiveListResponse>('session.active_list', { current_session_id: currentSid })

/** The session the current `sessionTitle` belongs to: a title is never carried over a session switch. */
let titleSid: null | string = null

/** Set the titlebar's session title for `sid` (every writer goes through here, so the owner is known). */
export function setSessionTitle(sid: null | string, title: string) {
  titleSid = sid

  if (getUiState().sessionTitle !== title) {
    patchUiState({ sessionTitle: title })
  }
}

/** The status bar's live count and the terminal titlebar's session title from one poll. Patches only
 * on a change: patchUiState always notifies every $uiState subscriber, and patching on each 1.5 s
 * poll re-renders the whole TUI (idle flicker).
 *
 * The owner's live feed is capped (newest `started_at` first, 200 rows), so a long-lived session can
 * drop out of it behind newer ones: absent from the roster is not untitled. Returns whether the
 * current session was listed; when it was not, the title this session already has stays and the
 * caller reads it directly (`refreshSessionTitle`). */
export function applyLiveSessionRoster(sessions: SessionActiveItem[]): boolean {
  const prev = getUiState()
  const liveSessionCount = sessions.length
  const row = sessions.find(s => s.current || s.id === prev.sid)

  if (prev.liveSessionCount !== liveSessionCount) {
    patchUiState({ liveSessionCount })
  }

  if (row) {
    setSessionTitle(prev.sid, row.title?.trim() ?? '')
  } else if (titleSid !== prev.sid) {
    setSessionTitle(prev.sid, '')
  }

  return Boolean(row)
}

/** The session's title from `session.title` (no title param = read), for a session the capped roster
 * does not list. Dropped when the session changed while the request was in flight. */
export function refreshSessionTitle(gw: Pick<GatewayClient, 'request'>, sid: string) {
  return gw
    .request<SessionTitleResponse>('session.title', { session_id: sid })
    .then(raw => {
      const result = asRpcResult<SessionTitleResponse>(raw)

      if (result && getUiState().sid === sid) {
        setSessionTitle(sid, (result.title ?? '').trim())
      }
    })
    .catch(() => {})
}
