/** Navigation history for diagram links in the preview pane.
 *
 *  Pure and path-only so the rules are testable without a rendered pane: the
 *  component owns fetching and drawing, this owns where "back" lands.
 *
 *  Scoped to diagram hops on purpose. Following a link inside a drawing is the
 *  only preview navigation that leaves no trail on screen — opening a file from
 *  the tree or a tool result is something the user just did somewhere visible,
 *  and they can get back the way they came. A diagram link replaces the whole
 *  pane with another drawing, and without this the way back is to remember the
 *  filename.
 */

export interface DiagramHistory {
  /** Files visited, oldest first. The last entry is what is on screen. */
  entries: string[]
}

export const EMPTY_DIAGRAM_HISTORY: DiagramHistory = { entries: [] }

/** Start a fresh trail at `path`. Opening a diagram from outside the pane
 *  (tree, tool result, chat) is a new journey, not a hop — keeping the old
 *  trail would let "back" jump to a drawing the user never navigated from. */
export function startHistory(path: string): DiagramHistory {
  return path ? { entries: [path] } : EMPTY_DIAGRAM_HISTORY
}

/** Record a hop from the current drawing to `path`.
 *
 *  Re-entering the drawing you just came from is treated as going back, not as
 *  a new hop: A → B → A would otherwise grow the trail forever on a pair of
 *  diagrams that link to each other, which is exactly what an L2 and its L3 do.
 */
export function pushHistory(history: DiagramHistory, path: string): DiagramHistory {
  if (!path) {
    return history
  }

  const { entries } = history

  if (entries[entries.length - 1] === path) {
    return history
  }

  if (entries.length > 1 && entries[entries.length - 2] === path) {
    return { entries: entries.slice(0, -1) }
  }

  return { entries: [...entries, path] }
}

/** True when there is somewhere to go back to. */
export function canGoBack(history: DiagramHistory): boolean {
  return history.entries.length > 1
}

/** Step back one drawing. Returns the same history when there is nowhere to
 *  go, so a caller can apply it unconditionally. */
export function goBack(history: DiagramHistory): DiagramHistory {
  return canGoBack(history) ? { entries: history.entries.slice(0, -1) } : history
}

/** The drawing currently on screen, or null for an empty trail. */
export function currentEntry(history: DiagramHistory): null | string {
  return history.entries[history.entries.length - 1] ?? null
}

/** What "back" would land on, for the button's tooltip — naming the
 *  destination beats a bare arrow when the trail is several diagrams deep. */
export function previousEntry(history: DiagramHistory): null | string {
  return canGoBack(history) ? history.entries[history.entries.length - 2] : null
}
