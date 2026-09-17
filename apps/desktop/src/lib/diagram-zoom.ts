/** Pan and zoom for a diagram surface.
 *
 *  Top-left anchored: the content's position is `translate`, in container
 *  coordinates, and its size is `natural * scale`. That is the whole model.
 *
 *  This deliberately does NOT reuse the image-zoom maths, which parametrises
 *  position as an offset from centre and leans on flex centring to place the
 *  element. Two coordinate systems deciding position at once is what made the
 *  diagram pane unfixable in small steps: every correction to one of them was
 *  silently undone by the other. Here, one number per axis says where the
 *  content is, and `clampTranslate` is the only thing that may change it.
 */

export interface Size {
  height: number
  width: number
}

export interface Point {
  x: number
  y: number
}

export interface ViewState {
  scale: number
  translate: Point
}

/** Scale 1 is "fits the pane". Zooming out below that only ever shows more
 *  emptiness, so the floor is the fit itself. */
export const MIN_SCALE = 1
export const MAX_SCALE = 16
/** One button press. The wheel derives its own factor from the delta. */
export const SCALE_STEP = 1.25

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return MIN_SCALE
  }

  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** The size the drawing occupies at scale 1: contained in the pane, never
 *  enlarged past its own dimensions. Returns null while either box is unknown,
 *  so a caller can wait instead of committing to a wrong baseline. */
export function fittedSize(natural: null | Size, pane: null | Size): null | Size {
  if (!natural || !pane || natural.width <= 0 || natural.height <= 0 || pane.width <= 0 || pane.height <= 0) {
    return null
  }

  const factor = Math.min(pane.width / natural.width, pane.height / natural.height, 1)

  return { height: natural.height * factor, width: natural.width * factor }
}

/** Where the content may sit, on one axis.
 *
 *  Smaller than the pane: centred, with no freedom — a drawing that fits has
 *  nowhere to go, and letting it drift would just lose it. Larger: anywhere
 *  between "right edge flush" and "left edge flush", so every part is
 *  reachable and no drag can push the drawing off the pane.
 */
export function clampAxis(value: number, contentSize: number, paneSize: number): number {
  if (contentSize <= paneSize) {
    return (paneSize - contentSize) / 2
  }

  return Math.min(0, Math.max(paneSize - contentSize, value))
}

export function clampTranslate(translate: Point, content: Size, pane: Size): Point {
  return {
    x: clampAxis(translate.x, content.width, pane.width),
    y: clampAxis(translate.y, content.height, pane.height)
  }
}

/** The content box at a given scale. */
export function contentSize(fitted: Size, scale: number): Size {
  const s = clampScale(scale)

  return { height: fitted.height * s, width: fitted.width * s }
}

/** The view that shows the whole drawing. */
export function fitView(fitted: Size, pane: Size): ViewState {
  return {
    scale: MIN_SCALE,
    translate: clampTranslate({ x: 0, y: 0 }, contentSize(fitted, MIN_SCALE), pane)
  }
}

/**
 * Zoom toward a focal point, keeping whatever is under it in place.
 *
 * `focus` is in container coordinates (0,0 = the pane's top-left corner). The
 * content point under the focus is `(focus - translate) / scale`; holding it
 * still across the scale change is what makes wheel zoom feel like magnifying
 * rather than being thrown around.
 */
export function zoomTo(view: ViewState, nextScale: number, focus: Point, fitted: Size, pane: Size): ViewState {
  const scale = clampScale(nextScale)

  if (scale === view.scale) {
    return view
  }

  const ratio = scale / view.scale
  const translate = {
    x: focus.x - (focus.x - view.translate.x) * ratio,
    y: focus.y - (focus.y - view.translate.y) * ratio
  }

  return { scale, translate: clampTranslate(translate, contentSize(fitted, scale), pane) }
}

/** Zoom a step from a control, anchored at the pane's centre. */
export function zoomByStep(view: ViewState, factor: number, fitted: Size, pane: Size): ViewState {
  return zoomTo(view, view.scale * factor, { x: pane.width / 2, y: pane.height / 2 }, fitted, pane)
}

/** Move the content by a drag delta. */
export function panBy(view: ViewState, delta: Point, fitted: Size, pane: Size): ViewState {
  return {
    ...view,
    translate: clampTranslate(
      { x: view.translate.x + delta.x, y: view.translate.y + delta.y },
      contentSize(fitted, view.scale),
      pane
    )
  }
}

/** A wheel notch, as a multiplier. Trackpads emit many small deltas and mice a
 *  few large ones; damping keeps both usable without a device sniff. */
export function scaleFromWheel(scale: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return scale
  }

  return clampScale(scale * Math.exp(-deltaY / 400))
}

/** True when there is more drawing than pane — the only state where dragging
 *  does anything, and so the only one that should look draggable. */
export function isPannable(view: ViewState, fitted: Size, pane: Size): boolean {
  const content = contentSize(fitted, view.scale)

  return content.width > pane.width + 0.5 || content.height > pane.height + 0.5
}
