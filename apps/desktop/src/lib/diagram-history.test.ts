import { describe, expect, it } from 'vitest'

import {
  canGoBack,
  currentEntry,
  EMPTY_DIAGRAM_HISTORY,
  goBack,
  previousEntry,
  pushHistory,
  startHistory
} from './diagram-history'

const L1 = '/repo/architecture/c4/l1-context.puml'
const L2 = '/repo/architecture/c4/l2-container.puml'
const L3 = '/repo/architecture/c4/l3-platform-api.puml'
const ERD = '/repo/architecture/data/erd-platform.puml'

describe('startHistory', () => {
  it('begins a trail at the opened file', () => {
    expect(startHistory(L1).entries).toEqual([L1])
  })

  it('ignores an empty path', () => {
    expect(startHistory('')).toEqual(EMPTY_DIAGRAM_HISTORY)
  })
})

describe('pushHistory', () => {
  it('records a hop', () => {
    expect(pushHistory(startHistory(L1), L2).entries).toEqual([L1, L2])
  })

  it('records the full descent L1 → L2 → ERD', () => {
    const history = pushHistory(pushHistory(startHistory(L1), L2), ERD)

    expect(history.entries).toEqual([L1, L2, ERD])
    expect(currentEntry(history)).toBe(ERD)
  })

  it('ignores a hop to the drawing already on screen', () => {
    expect(pushHistory(startHistory(L1), L1).entries).toEqual([L1])
  })

  // An L2 links down to its L3 and the L3 links back up. Treating the return
  // as a hop would grow the trail without bound on two diagrams.
  it('treats a hop back to the previous drawing as going back', () => {
    const down = pushHistory(startHistory(L2), L3)

    expect(pushHistory(down, L2).entries).toEqual([L2])
  })

  it('ignores an empty path', () => {
    const history = startHistory(L1)

    expect(pushHistory(history, '')).toBe(history)
  })
})

describe('canGoBack / goBack', () => {
  it('has nowhere to go from the first drawing', () => {
    const history = startHistory(L1)

    expect(canGoBack(history)).toBe(false)
    expect(goBack(history)).toBe(history)
  })

  it('steps back one drawing at a time', () => {
    const deep = pushHistory(pushHistory(startHistory(L1), L2), ERD)
    const once = goBack(deep)

    expect(currentEntry(once)).toBe(L2)
    expect(currentEntry(goBack(once))).toBe(L1)
  })

  it('stops at the start of the trail', () => {
    const start = goBack(goBack(pushHistory(startHistory(L1), L2)))

    expect(currentEntry(start)).toBe(L1)
    expect(canGoBack(start)).toBe(false)
  })

  // Going back and then following a different link forgets the abandoned
  // branch, the way a browser does.
  it('replaces the forward branch after a back', () => {
    const wentBack = goBack(pushHistory(startHistory(L2), L3))

    expect(pushHistory(wentBack, ERD).entries).toEqual([L2, ERD])
  })
})

describe('previousEntry', () => {
  it('names the destination for the button tooltip', () => {
    expect(previousEntry(pushHistory(startHistory(L1), L2))).toBe(L1)
  })

  it('is null with nowhere to go', () => {
    expect(previousEntry(startHistory(L1))).toBeNull()
  })
})

describe('currentEntry', () => {
  it('is null for an empty trail', () => {
    expect(currentEntry(EMPTY_DIAGRAM_HISTORY)).toBeNull()
  })
})
