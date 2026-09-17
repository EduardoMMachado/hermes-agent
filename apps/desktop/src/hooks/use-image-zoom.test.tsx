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
})
