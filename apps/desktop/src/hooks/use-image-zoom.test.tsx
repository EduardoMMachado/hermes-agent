import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'

import { useImageZoom } from './use-image-zoom'

/** A vector surface whose content can be swapped, like the diagram pane moving
 *  from one drawing to the next. */
function VectorSurface({ height, onZoom, width }: { height: number; onZoom?: (z: Zoom) => void; width: number }) {
  const zoom = useImageZoom(true, true)

  useEffect(() => {
    const node = zoom.imageRef.current as unknown as HTMLElement | null

    if (node) {
      // jsdom has no layout: publish the box the hook measures.
      Object.defineProperty(node, 'offsetWidth', { configurable: true, value: width })
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: height })
    }

    onZoom?.(zoom)
  }, [height, onZoom, width, zoom])

  return (
    <div {...zoom.containerProps}>
      <div
        ref={node => {
          zoom.imageRef.current = node as unknown as HTMLImageElement | null
        }}
      />
    </div>
  )
}

type Zoom = ReturnType<typeof useImageZoom>

describe('useImageZoom on a vector surface', () => {
  it('scales the node by layout, keeping a vector sharp', () => {
    let zoom: null | Zoom = null

    render(<VectorSurface height={400} onZoom={z => (zoom = z)} width={800} />)

    act(() => zoom!.zoomIn())

    const node = zoom!.imageRef.current as unknown as HTMLElement

    // Layout, not transform: a transform scale would blur the render.
    expect(node.style.width).not.toBe('')
    expect(node.style.transform).not.toContain('scale(')
  })

  // The regression this pins: the measured baseline is captured once and was
  // never cleared, so a pane that swaps drawings kept panning against the
  // previous drawing's size — a large diagram opened after a small one could
  // barely be moved, hiding most of it.
  it('forgets the measured baseline on reset', () => {
    let zoom: null | Zoom = null
    const { rerender } = render(<VectorSurface height={200} onZoom={z => (zoom = z)} width={400} />)

    act(() => zoom!.zoomIn())

    const small = (zoom!.imageRef.current as unknown as HTMLElement).style.width

    act(() => zoom!.reset())
    rerender(<VectorSurface height={1000} onZoom={z => (zoom = z)} width={2000} />)
    act(() => zoom!.zoomIn())

    const large = (zoom!.imageRef.current as unknown as HTMLElement).style.width

    expect(large).not.toBe(small)
  })

  it('returns to the stylesheet box on reset', () => {
    let zoom: null | Zoom = null

    render(<VectorSurface height={400} onZoom={z => (zoom = z)} width={800} />)

    act(() => zoom!.zoomIn())
    act(() => zoom!.reset())

    const node = zoom!.imageRef.current as unknown as HTMLElement

    expect(node.style.width).toBe('')
    expect(node.style.maxWidth).toBe('')
    expect(zoom!.scale).toBe(1)
  })

  it('reports nothing to zoom out from at rest', () => {
    let zoom: null | Zoom = null

    render(<VectorSurface height={400} onZoom={z => (zoom = z)} width={800} />)

    expect(zoom!.canZoomOut).toBe(false)
    expect(zoom!.isZoomed).toBe(false)
  })

  // The regression this pins: the hook returns a fresh object literal every
  // render. A consumer that resets when its content changes must depend on
  // `reset`, not on the whole zoom object — otherwise the effect re-runs on
  // the very render that zooming causes, and every zoom snaps back to 100%.
  it('exposes a reset that is stable across renders', () => {
    const seen: unknown[] = []

    function Collect() {
      const zoom = useImageZoom(true, true)

      seen.push(zoom.reset)

      return (
        <div {...zoom.containerProps}>
          <button data-testid="zin" onClick={zoom.zoomIn} type="button" />
          <div
            ref={node => {
              zoom.imageRef.current = node as unknown as HTMLImageElement | null
            }}
          />
        </div>
      )
    }

    const { getByTestId } = render(<Collect />)

    act(() => getByTestId('zin').click())

    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(1)
  })
})

describe('useImageZoom with a declared natural size', () => {
  // The regression this pins, measured in a browser: reset() blanked the
  // width, React never rewrote the unchanged style prop, and the host
  // collapsed from 468x368 to its content at 300x180. Every later zoom then
  // multiplied the collapsed box — 2x landed at 600x360, barely past the fit,
  // so the drawing appeared to shift rather than magnify.
  it('restores the declared box on reset instead of collapsing it', () => {
    let zoom: null | Zoom = null

    function Declared() {
      const z = useImageZoom(true, true, false, { height: 600, width: 1000 })

      zoom = z

      return (
        <div {...z.containerProps}>
          <div
            data-testid="host"
            ref={node => {
              z.imageRef.current = node as unknown as HTMLImageElement | null
            }}
          />
        </div>
      )
    }

    const { getByTestId } = render(<Declared />)

    act(() => zoom!.zoomIn())
    act(() => zoom!.reset())

    expect(getByTestId('host').style.width).toBe('1000px')
  })

  it('scales from the declared size, not from the laid-out box', () => {
    let zoom: null | Zoom = null

    function Declared() {
      const z = useImageZoom(true, true, false, { height: 600, width: 1000 })

      zoom = z

      return (
        <div {...z.containerProps}>
          <div
            data-testid="host"
            ref={node => {
              z.imageRef.current = node as unknown as HTMLImageElement | null
            }}
          />
        </div>
      )
    }

    const { getByTestId } = render(<Declared />)

    act(() => zoom!.zoomIn())

    // ZOOM_STEP is 1.25: the box must come from 1000, not from jsdom's 0.
    expect(getByTestId('host').style.width).toBe('1250px')
  })
})
