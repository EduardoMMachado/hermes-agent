import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useDiagramZoom } from './use-diagram-zoom'

const DRAWING = { height: 600, width: 1000 }

function Surface() {
  const zoom = useDiagramZoom(DRAWING)

  return (
    <div data-testid="pane" ref={zoom.paneRef} style={{ height: 400, width: 500 }}>
      <div data-testid="content" style={zoom.contentStyle} />
      <span data-testid="scale">{zoom.scale}</span>
    </div>
  )
}

describe('useDiagramZoom wheel binding', () => {
  // The regression this pins: React attaches wheel listeners passively, so
  // preventDefault() there is a silent no-op and the browser scrolls an
  // ancestor as well — a trackpad's two-finger gesture then slides the drawing
  // diagonally while it zooms. The listener must be registered natively with
  // { passive: false }.
  it('registers wheel as non-passive so preventDefault works', () => {
    const seen: Array<boolean | undefined> = []
    const proto = Element.prototype
    const original = proto.addEventListener

    proto.addEventListener = function (this: Element, type: string, listener: never, options?: never) {
      if (type === 'wheel') {
        const opts = options as AddEventListenerOptions | boolean | undefined

        seen.push(typeof opts === 'object' ? opts.passive : undefined)
      }

      return original.call(this, type, listener, options)
    } as typeof proto.addEventListener

    try {
      render(<Surface />)
    } finally {
      proto.addEventListener = original
    }

    expect(seen).toContain(false)
  })

  it('cancels the event so no ancestor scrolls', () => {
    const { getByTestId } = render(<Surface />)
    const pane = getByTestId('pane')
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 })

    act(() => {
      pane.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
  })
})
