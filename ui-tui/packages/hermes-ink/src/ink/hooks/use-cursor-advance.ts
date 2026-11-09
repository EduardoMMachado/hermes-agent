import { useContext } from 'react'

import CursorAdvanceContext, { type CursorAdvanceNotifier } from '../components/CursorAdvanceContext.js'

/**
 * Returns a function that notifies Ink the physical terminal cursor was
 * advanced out-of-band (e.g. by a direct stdout.write from the
 * TextInput fast-echo bypass).
 *
 * Calling the returned function updates two pieces of Ink state:
 *
 *   - `displayCursor` — the cached parked-cursor position log-update
 *     uses as the relative-move basis for the next frame. Skipped on
 *     alt-screen, where every frame's CSI H resets the cursor anyway.
 *
 *   - The active `cursorDeclaration` — the target the cursor parks at
 *     after every frame. Bumped on BOTH main- and alt-screen, because
 *     onRender's alt-screen park branch emits an absolute CUP from
 *     this value and a stale declaration there is still visibly wrong.
 *     The next React commit that publishes a fresh declaration
 *     supersedes the bump.
 *
 * The caller owns the stdout write. Call `prepare?.()` before a bypass:
 * it paints a pending cursor declaration using Ink's normal frame path and
 * returns false when no usable caret baseline exists. Declaring a cursor in
 * a layout effect alone does not mean a throttled frame has parked it yet.
 * After the write, pass `dx` and optional
 * `dy` in terminal cells (positive = moved right/down, negative =
 * moved left/up).
 *
 * If the host isn't an Ink render root (test stubs, non-Ink renderer)
 * the returned callback is a safe no-op.
 */
export function useCursorAdvance(): CursorAdvanceNotifier {
  return useContext(CursorAdvanceContext)
}
