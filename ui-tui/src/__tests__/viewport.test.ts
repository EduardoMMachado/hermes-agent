import { describe, expect, it } from 'vitest'

import { stickyPromptFromViewport, stickyPromptIndexFromViewport } from '../domain/viewport.js'

describe('stickyPromptFromViewport', () => {
  it('keeps the request above the viewport even if the next turn starts farther down the screen', () => {
    const messages = [
      { role: 'user' as const, text: 'older prompt' },
      { role: 'assistant' as const, text: 'older answer' },
      { role: 'user' as const, text: 'current prompt' },
      { role: 'assistant' as const, text: 'current answer' }
    ]

    const offsets = [0, 2, 10, 12, 20]

    expect(stickyPromptFromViewport(messages, offsets, 8, 16, false)).toBe('older prompt')
    expect(stickyPromptIndexFromViewport(messages, offsets, 8)).toBe(0)
    expect(stickyPromptIndexFromViewport(messages, offsets, 16)).toBe(2)
  })

  it('shows the latest user message above the viewport when no user message is visible', () => {
    const messages = [
      { role: 'user' as const, text: 'older prompt' },
      { role: 'assistant' as const, text: 'older answer' },
      { role: 'user' as const, text: 'current prompt' },
      { role: 'assistant' as const, text: 'current answer' }
    ]

    const offsets = [0, 2, 10, 12, 20]

    expect(stickyPromptFromViewport(messages, offsets, 16, 20, false)).toBe('current prompt')
  })

  it('shows the last prompt once the viewport starts after the history tail', () => {
    const messages = [
      { role: 'user' as const, text: 'current prompt' },
      { role: 'assistant' as const, text: 'completed answer' }
    ]

    expect(stickyPromptFromViewport(messages, [0, 2, 5], 8, 14, false)).toBe('current prompt')
  })

  it('shows a prompt as soon as its full row is above the viewport', () => {
    const messages = [
      { role: 'user' as const, text: 'current prompt' },
      { role: 'assistant' as const, text: 'current answer' }
    ]

    expect(stickyPromptFromViewport(messages, [0, 2, 10], 2, 8, false)).toBe('current prompt')
  })

  it('keeps the last request visible while auto-following a long answer', () => {
    const messages = [
      { role: 'user' as const, text: 'current prompt' },
      { role: 'assistant' as const, text: 'current answer' }
    ]

    expect(stickyPromptFromViewport(messages, [0, 2, 10], 8, 10, true)).toBe('current prompt')
  })

  it('does not duplicate a partially visible original request', () => {
    const messages = [{ role: 'user' as const, text: 'long request' }, { role: 'assistant' as const, text: 'answer' }]
    expect(stickyPromptFromViewport(messages, [0, 5, 20], 4, 10, false)).toBe('')
  })

  it('does not pin a future request below the viewport', () => {
    const messages = [
      { role: 'user' as const, text: 'old request' },
      { role: 'assistant' as const, text: 'old answer' },
      { role: 'user' as const, text: 'latest request' }
    ]

    expect(stickyPromptFromViewport(messages, [0, 2, 20, 22], 0, 10, false)).toBe('')
    expect(stickyPromptFromViewport(messages, [0, 2, 20, 22], 5, 15, false)).toBe('old request')
    expect(stickyPromptFromViewport(messages, [0, 2, 20, 22], 20, 30, false)).toBe('')
    expect(stickyPromptFromViewport(messages, [0, 2, 20, 22], 22, 30, false)).toBe('latest request')
  })

  it('ignores user-role timeline events and waits for measured geometry', () => {
    const messages = [
      { role: 'user' as const, text: 'actual request' },
      { role: 'user' as const, kind: 'event' as const, text: 'notification' }
    ]

    expect(stickyPromptFromViewport(messages, [0, 2, 4], 8, 10, true)).toBe('actual request')
    expect(stickyPromptFromViewport(messages, [], 8, 10, true)).toBe('')
  })
})
