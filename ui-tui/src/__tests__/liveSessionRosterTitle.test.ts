import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyLiveSessionRoster, refreshSessionTitle, setSessionTitle } from '../app/liveSessions.js'
import { getUiState, patchUiState, resetUiState } from '../app/uiStore.js'
import type { SessionActiveItem } from '../gatewayTypes.js'

// The owner's live `session.list` answers at most 200 rows, newest `started_at` first. Once 200 newer
// live sessions exist (e.g. open cron runs), a long-lived TUI session is not in the roster at all.
const cappedRoster = (): SessionActiveItem[] =>
  Array.from({ length: 200 }, (_, i) => ({ id: `local-cron-${i}`, status: 'idle', title: '' }))

describe('the titlebar session title survives a capped live roster', () => {
  beforeEach(() => {
    resetUiState()
    setSessionTitle(null, '')
  })

  it('keeps the title the roster gave earlier when the session drops out of it', () => {
    patchUiState({ sid: 'local-mine' })
    applyLiveSessionRoster([{ id: 'local-mine', status: 'idle', title: 'Hermes UX' }])
    expect(applyLiveSessionRoster(cappedRoster())).toBe(false)
    expect(getUiState().sessionTitle).toBe('Hermes UX')
    expect(getUiState().liveSessionCount).toBe(200)
  })

  it('never carries the previous session title into an unlisted session, and reads it directly', async () => {
    patchUiState({ sid: 'local-a' })
    applyLiveSessionRoster([{ id: 'local-a', status: 'idle', title: 'Old session' }])
    patchUiState({ sid: 'local-b' })
    applyLiveSessionRoster(cappedRoster())
    expect(getUiState().sessionTitle).toBe('')

    const request = vi.fn(async () => ({ title: ' Pipeline ' }))
    await refreshSessionTitle({ request } as never, 'local-b')
    expect(request).toHaveBeenCalledWith('session.title', { session_id: 'local-b' })
    expect(getUiState().sessionTitle).toBe('Pipeline')
    applyLiveSessionRoster(cappedRoster())
    expect(getUiState().sessionTitle).toBe('Pipeline')
  })

  it('drops a direct read that lands after a session switch', async () => {
    patchUiState({ sid: 'local-b' })

    let answer: (v: unknown) => void = () => {}
    const pending = refreshSessionTitle({ request: () => new Promise(r => (answer = r)) } as never, 'local-b')
    patchUiState({ sid: 'local-c' })
    answer({ title: 'Stale' })
    await pending
    expect(getUiState().sessionTitle).toBe('')
  })

  it('a rename via /title sticks while the session is unlisted, and the roster wins when it lists it', () => {
    patchUiState({ sid: 'local-mine' })
    setSessionTitle('local-mine', 'Renamed')
    applyLiveSessionRoster(cappedRoster())
    expect(getUiState().sessionTitle).toBe('Renamed')
    applyLiveSessionRoster([{ id: 'local-mine', status: 'idle', title: '' }])
    expect(getUiState().sessionTitle).toBe('')
  })
})
