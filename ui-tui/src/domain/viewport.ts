import type { Msg } from '../types.js'

/** While following the bottom, the banner must not move its own reading anchor. */
export const stickyPromptReadingTop = (
  top: number, viewportHeight: number, fullPaneHeight: number, followingBottom: boolean
) => Math.max(0, top - (followingBottom ? Math.max(0, fullPaneHeight - viewportHeight) : 0))


/** The request owning the visible context, not the globally latest request. */
export const stickyPromptIndexFromViewport = (
  messages: readonly Msg[],
  offsets: ArrayLike<number>,
  top: number
) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user' || messages[i]?.kind) {
      continue
    }

    const start = offsets[i]
    const end = offsets[i + 1]

    if (start == null || end == null) {
      return -1
    }

    // Requests farther down the conversation do not own this viewport yet.
    if (start > top) {
      continue
    }

    // Do not duplicate a request still partially on screen.
    return end <= top ? i : -1
  }

  return -1
}

export const stickyPromptFromViewport = (
  messages: readonly Msg[],
  offsets: ArrayLike<number>,
  top: number,
  _bottom: number,
  _sticky: boolean
) => {
  const index = stickyPromptIndexFromViewport(messages, offsets, top)

  return index < 0 ? '' : messages[index]!.fullText ?? messages[index]!.text
}
