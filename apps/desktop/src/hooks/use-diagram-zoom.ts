import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  clampTranslate,
  contentSize,
  fittedSize,
  fitView,
  isPannable,
  MIN_SCALE,
  panBy,
  type Point,
  scaleFromWheel,
  SCALE_STEP,
  type Size,
  type ViewState,
  zoomByStep,
  zoomTo
} from '@/lib/diagram-zoom'

/** Pan and zoom for the diagram pane.
 *
 *  Everything on screen is derived from one piece of state — `{ scale,
 *  translate }` — and written through React's style prop. Nothing here reaches
 *  for `node.style` behind React's back: doing that is what made the previous
 *  attempt unfixable, because React then declined to rewrite values it
 *  believed unchanged and the box silently collapsed.
 */
export function useDiagramZoom(natural: null | Size) {
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [pane, setPane] = useState<null | Size>(null)
  const [view, setView] = useState<ViewState>({ scale: MIN_SCALE, translate: { x: 0, y: 0 } })
  const dragRef = useRef<null | { origin: Point; pointerId: number; start: Point }>(null)
  const [dragging, setDragging] = useState(false)

  // The pane is the frame of reference for fit, zoom focus and pan limits, so
  // it is measured rather than assumed — and re-measured when the rail is
  // resized or the window changes shape.
  useEffect(() => {
    const node = paneRef.current

    if (!node) {
      return
    }

    const measure = () => {
      const rect = node.getBoundingClientRect()

      setPane(prev =>
        prev && Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { height: rect.height, width: rect.width }
      )
    }

    measure()

    const observer = new ResizeObserver(measure)

    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  const fitted = useMemo(() => fittedSize(natural, pane), [natural, pane])

  // Show the whole drawing whenever the drawing or the frame changes. A new
  // diagram inheriting the previous one's zoom would land mid-detail on
  // coordinates that mean nothing here.
  useEffect(() => {
    if (fitted && pane) {
      setView(fitView(fitted, pane))
    }
  }, [fitted, pane])

  const ready = Boolean(fitted && pane)

  const zoomIn = useCallback(() => {
    if (fitted && pane) {
      setView(prev => zoomByStep(prev, SCALE_STEP, fitted, pane))
    }
  }, [fitted, pane])

  const zoomOut = useCallback(() => {
    if (fitted && pane) {
      setView(prev => zoomByStep(prev, 1 / SCALE_STEP, fitted, pane))
    }
  }, [fitted, pane])

  const reset = useCallback(() => {
    if (fitted && pane) {
      setView(fitView(fitted, pane))
    }
  }, [fitted, pane])

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!fitted || !pane) {
        return
      }

      // The pane owns the gesture: without this the rail scrolls underneath and
      // the diagram appears to jump.
      event.preventDefault()

      const rect = paneRef.current?.getBoundingClientRect()
      const focus = rect
        ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
        : { x: pane.width / 2, y: pane.height / 2 }

      setView(prev => zoomTo(prev, scaleFromWheel(prev.scale, event.deltaY), focus, fitted, pane))
    },
    [fitted, pane]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button only, and only when there is something to pan — otherwise
      // this would swallow clicks on the diagram's own links.
      if (event.button !== 0 || !fitted || !pane || !isPannable(view, fitted, pane)) {
        return
      }

      dragRef.current = {
        origin: view.translate,
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY }
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    },
    [fitted, pane, view]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current

      if (!drag || drag.pointerId !== event.pointerId || !fitted || !pane) {
        return
      }

      const next = {
        x: drag.origin.x + (event.clientX - drag.start.x),
        y: drag.origin.y + (event.clientY - drag.start.y)
      }

      setView(prev => ({
        ...prev,
        translate: clampTranslate(next, contentSize(fitted, prev.scale), pane)
      }))
    },
    [fitted, pane]
  )

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current

    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    dragRef.current = null
    setDragging(false)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const content = fitted ? contentSize(fitted, view.scale) : null
  const pannable = Boolean(fitted && pane && isPannable(view, fitted, pane))

  return {
    canZoomIn: view.scale < 16,
    canZoomOut: view.scale > MIN_SCALE,
    /** Inline style for the content box — size and position in one place. */
    contentStyle: content
      ? {
          height: content.height,
          transform: `translate3d(${view.translate.x}px, ${view.translate.y}px, 0)`,
          width: content.width
        }
      : undefined,
    dragging,
    endDrag,
    isZoomed: view.scale > MIN_SCALE,
    onPointerDown,
    onPointerMove,
    onWheel,
    paneRef,
    pannable,
    ready,
    reset,
    scale: view.scale,
    zoomIn,
    zoomOut
  }
}
