/**
 * Zoom + pan math for the image lightbox.
 *
 * Pure and DOM-free so the behaviour can be tested directly: the component
 * owns gestures and rendering, this owns what the numbers must be.
 *
 * The lightbox opens fit-to-screen, so `MIN_ZOOM` is 1 — below that the image
 * would shrink inside an already-fitted box for nothing. Zooming out means
 * walking back toward the fit, not past it.
 */

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

/** One button press / keyboard step. */
export const ZOOM_STEP = 1.25

export interface Point {
  x: number
  y: number
}

export interface Size {
  height: number
  width: number
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

export function zoomBy(scale: number, factor: number): number {
  return clampZoom(scale * factor)
}

/**
 * Wheel delta to a zoom factor.
 *
 * Exponential in the delta so a trackpad's many small events and a mouse's few
 * large ones travel at the same rate per unit scrolled, and so repeated zooming
 * feels linear to the eye (each notch is a constant *ratio*, not a constant
 * addend).
 */
export function zoomFromWheel(scale: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoom(scale)
  return clampZoom(scale * Math.exp(-deltaY / 320))
}

/**
 * How far the image may travel from center on one axis.
 *
 * Only the overflow is reachable: at fit (scale 1) there is none, so panning is
 * pinned to center and the image can never be dragged off-screen.
 */
export function maxPanOffset(baseSize: number, scale: number): number {
  if (!Number.isFinite(baseSize) || baseSize <= 0) return 0
  return Math.max(0, (baseSize * clampZoom(scale) - baseSize) / 2)
}

export function clampPan(offset: Point, base: Size, scale: number): Point {
  const maxX = maxPanOffset(base.width, scale)
  const maxY = maxPanOffset(base.height, scale)
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y))
  }
}

/**
 * Keep the point under the cursor pinned while the scale changes.
 *
 * Without this, zooming always pulls toward the image's center and the detail
 * being inspected slides away — the difference between reading a diagram and
 * chasing it. `cursor` is relative to the container's center.
 */
export function panForZoomAtPoint(
  cursor: Point,
  offset: Point,
  prevScale: number,
  nextScale: number
): Point {
  if (prevScale <= 0) return offset
  const ratio = nextScale / prevScale
  return {
    x: cursor.x - (cursor.x - offset.x) * ratio,
    y: cursor.y - (cursor.y - offset.y) * ratio
  }
}

/** Zoom toward a focal point and land inside the pan bounds in one step. */
export function zoomAtPoint(
  cursor: Point,
  offset: Point,
  prevScale: number,
  nextScale: number,
  base: Size
): { offset: Point; scale: number } {
  const scale = clampZoom(nextScale)
  return {
    offset: clampPan(panForZoomAtPoint(cursor, offset, prevScale, scale), base, scale),
    scale
  }
}
