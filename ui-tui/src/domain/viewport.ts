import type { Msg } from '../types.js'

import { userDisplay } from './messages.js'

export const stickyPromptFromViewport = (
  messages: readonly Msg[],
  offsets: ArrayLike<number>,
  top: number,
  bottom: number,
  _sticky: boolean
) => {
  // Always track the latest real request, even when looking at an earlier turn.
  // Auto-following the streaming tail does not make the request visible again.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user' || messages[i]?.kind) {
      continue
    }

    const start = offsets[i]
    const end = offsets[i + 1]

    // Unknown geometry is not evidence that the original message is off screen.
    if (start == null || end == null || (start < bottom && end > top)) {
      return ''
    }

    return userDisplay(messages[i]!.text.trim()).replace(/\s+/g, ' ').trim()
  }

  return ''
}
