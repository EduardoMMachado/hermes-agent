import { describe, expect, it } from 'vitest'

import { sessionTitleMarker } from '../lib/sessionTitleMarker.js'

describe('sessionTitleMarker', () => {
  it('reserves the completion check for an idle session with no background work', () => {
    expect(sessionTitleMarker({ blocked: false, busy: false, background: 0 })).toBe('✓')
    expect(sessionTitleMarker({ blocked: false, busy: false, background: 1 })).toBe('◷ 1 bg ·')
    expect(sessionTitleMarker({ blocked: false, busy: false, background: 12 })).toBe('◷ 12 bg ·')
  })

  it('keeps prompts requiring attention and foreground processing higher priority', () => {
    expect(sessionTitleMarker({ blocked: true, busy: false, background: 1 })).toBe('⚠')
    expect(sessionTitleMarker({ blocked: true, busy: true, background: 1 })).toBe('⚠')
    expect(sessionTitleMarker({ blocked: false, busy: true, background: 1 })).toBe('⏳')
  })
})
