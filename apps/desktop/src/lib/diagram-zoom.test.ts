import { describe, expect, it } from 'vitest'

import {
  clampAxis,
  clampScale,
  clampTranslate,
  contentSize,
  fittedSize,
  fitView,
  isPannable,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  scaleFromWheel,
  SCALE_STEP,
  zoomByStep,
  zoomTo
} from './diagram-zoom'

/** The reported case: a wide drawing in a narrow pane. */
const DRAWING = { height: 600, width: 1000 }
const PANE = { height: 400, width: 500 }
const FIT = fittedSize(DRAWING, PANE)!

describe('fittedSize', () => {
  it('contains the drawing in the pane', () => {
    // 500/1000 = 0.5 is the tighter axis (400/600 = 0.67).
    expect(FIT).toEqual({ height: 300, width: 500 })
  })

  it('never enlarges a drawing smaller than the pane', () => {
    expect(fittedSize({ height: 100, width: 200 }, PANE)).toEqual({ height: 100, width: 200 })
  })

  it('waits rather than guessing while a box is unknown', () => {
    expect(fittedSize(DRAWING, null)).toBeNull()
    expect(fittedSize(null, PANE)).toBeNull()
    expect(fittedSize(DRAWING, { height: 0, width: 0 })).toBeNull()
  })
})

describe('the fit view', () => {
  it('starts at scale 1 with the drawing centred', () => {
    const view = fitView(FIT, PANE)

    expect(view.scale).toBe(MIN_SCALE)
    // 500 wide in a 500 pane: no horizontal slack. 300 tall in 400: centred.
    expect(view.translate).toEqual({ x: 0, y: 50 })
  })
})

describe('zooming actually enlarges', () => {
  // The bug this pins, reported over and over: the drawing appeared to shift
  // instead of growing, because scale 1 was the drawing's full size while the
  // pane was visually shrinking it. Scale 1 IS the fitted size here, so every
  // step is visible.
  it('grows the content on every step', () => {
    let view = fitView(FIT, PANE)
    const sizes = [contentSize(FIT, view.scale).width]

    for (let i = 0; i < 3; i += 1) {
      view = zoomByStep(view, SCALE_STEP, FIT, PANE)
      sizes.push(contentSize(FIT, view.scale).width)
    }

    expect(sizes).toEqual([500, 625, 781.25, 976.5625])
    // Strictly increasing — no step that leaves the size alone.
    expect(sizes.every((w, i) => i === 0 || w > sizes[i - 1])).toBe(true)
  })

  it('stops at the ceiling instead of drifting', () => {
    let view = fitView(FIT, PANE)

    for (let i = 0; i < 40; i += 1) {
      view = zoomByStep(view, SCALE_STEP, FIT, PANE)
    }

    expect(view.scale).toBe(MAX_SCALE)
  })

  it('cannot zoom out past the fit', () => {
    const view = zoomByStep(fitView(FIT, PANE), 1 / SCALE_STEP, FIT, PANE)

    expect(view.scale).toBe(MIN_SCALE)
  })
})

describe('wheel zoom keeps the point under the cursor', () => {
  it('holds the focal point still', () => {
    const view = fitView(FIT, PANE)
    const focus = { x: 100, y: 120 }
    // The content point under the cursor, before.
    const before = { x: (focus.x - view.translate.x) / view.scale, y: (focus.y - view.translate.y) / view.scale }

    const next = zoomTo(view, 2, focus, FIT, PANE)
    const after = { x: (focus.x - next.translate.x) / next.scale, y: (focus.y - next.translate.y) / next.scale }

    expect(after.x).toBeCloseTo(before.x, 5)
    expect(after.y).toBeCloseTo(before.y, 5)
  })

  it('translates a wheel delta into a scale', () => {
    expect(scaleFromWheel(1, -100)).toBeGreaterThan(1)
    expect(scaleFromWheel(2, 100)).toBeLessThan(2)
    expect(scaleFromWheel(1, 0)).toBe(1)
    expect(scaleFromWheel(1, Number.NaN)).toBe(1)
  })

  it('never leaves the pan bounds, wherever the cursor is', () => {
    let view = fitView(FIT, PANE)

    // Zoom hard at the top-left corner, then check nothing escaped.
    for (let i = 0; i < 10; i += 1) {
      view = zoomTo(view, view.scale * 1.4, { x: 0, y: 0 }, FIT, PANE)
    }

    const content = contentSize(FIT, view.scale)

    expect(view.translate.x).toBeLessThanOrEqual(0)
    expect(view.translate.x).toBeGreaterThanOrEqual(PANE.width - content.width)
  })
})

describe('panning reaches every edge', () => {
  // The other half of the report: at zoom, parts of the drawing could not be
  // reached because the limit was computed from the wrong box.
  it('reaches the right edge exactly', () => {
    const view = zoomByStep(fitView(FIT, PANE), 4, FIT, PANE)
    const dragged = panBy(view, { x: -99999, y: 0 }, FIT, PANE)
    const content = contentSize(FIT, view.scale)

    expect(dragged.translate.x).toBe(PANE.width - content.width)
  })

  it('reaches the left edge exactly', () => {
    const view = zoomByStep(fitView(FIT, PANE), 4, FIT, PANE)
    const dragged = panBy(view, { x: 99999, y: 0 }, FIT, PANE)

    expect(dragged.translate.x).toBe(0)
  })

  it('keeps a fitted drawing centred however hard it is dragged', () => {
    const view = fitView(FIT, PANE)

    expect(panBy(view, { x: 400, y: 400 }, FIT, PANE).translate).toEqual(view.translate)
  })
})

describe('clampAxis', () => {
  it('centres content smaller than the pane', () => {
    expect(clampAxis(-999, 200, 500)).toBe(150)
    expect(clampAxis(999, 200, 500)).toBe(150)
  })

  it('allows the full range for content larger than the pane', () => {
    expect(clampAxis(0, 1000, 500)).toBe(0)
    expect(clampAxis(-500, 1000, 500)).toBe(-500)
    expect(clampAxis(-9999, 1000, 500)).toBe(-500)
    expect(clampAxis(50, 1000, 500)).toBe(0)
  })
})

describe('clampScale', () => {
  it('holds the floor and ceiling', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE)
    expect(clampScale(999)).toBe(MAX_SCALE)
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
  })
})

describe('isPannable', () => {
  it('is false at the fit and true once zoomed', () => {
    const fit = fitView(FIT, PANE)

    expect(isPannable(fit, FIT, PANE)).toBe(false)
    expect(isPannable(zoomByStep(fit, 2, FIT, PANE), FIT, PANE)).toBe(true)
  })
})

describe('clampTranslate', () => {
  it('clamps both axes independently', () => {
    const out = clampTranslate({ x: 999, y: -999 }, { height: 800, width: 1000 }, PANE)

    expect(out).toEqual({ x: 0, y: -400 })
  })
})
