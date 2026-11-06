import { describe, expect, it } from 'vitest'

import { stickyPromptIndexFromViewport, stickyPromptReadingTop } from '../domain/viewport.js'

const messages = [
  { role: 'user' as const, text: 'first' }, { role: 'assistant' as const, text: 'answer' },
  { role: 'user' as const, text: 'second' }, { role: 'assistant' as const, text: 'answer' }
]

const offsets = [0, 7, 15, 18, 24]

describe('sticky reading anchor', () => {
  it('stays at the same context when a seven-row banner shrinks a bottom-following viewport', () => {
    const before = stickyPromptReadingTop(8, 16, 16, true)
    const after = stickyPromptReadingTop(15, 9, 16, true)
    expect(before).toBe(8)
    expect(after).toBe(before)
    expect(stickyPromptIndexFromViewport(messages, offsets, after)).toBe(0)
  })

  it('uses the actual reading position for manual scrolling, including a partially visible request', () => {
    expect(stickyPromptReadingTop(15, 9, 16, false)).toBe(15)
    expect(stickyPromptIndexFromViewport(messages, offsets, 15)).toBe(-1)
    expect(stickyPromptIndexFromViewport(messages, offsets, stickyPromptReadingTop(19, 9, 16, false))).toBe(2)
  })

  it('hides after jumping to the shown request and never selects a later request for that click', () => {
    const target = stickyPromptIndexFromViewport(messages, offsets, stickyPromptReadingTop(15, 9, 16, true))
    expect(target).toBe(0)
    const jumpTop = offsets[target]
    expect(stickyPromptIndexFromViewport(messages, offsets, stickyPromptReadingTop(jumpTop, 9, 16, false))).toBe(-1)
  })

  it('clamps short content and does not invent header space before measurement', () => {
    expect(stickyPromptReadingTop(0, 9, 16, true)).toBe(0)
    expect(stickyPromptReadingTop(8, 16, 0, true)).toBe(8)
  })
})
