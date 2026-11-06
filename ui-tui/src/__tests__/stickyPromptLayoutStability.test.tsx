import { PassThrough } from 'node:stream'

import { Box, measureElement, renderSync, ScrollBox, type ScrollBoxHandle, Text } from '@hermes/ink'
import React, { useCallback, useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StickyPromptTracker } from '../components/appChrome.js'
import { StickyUserPrompt } from '../components/stickyUserPrompt.js'
import { stickyPromptReadingTop } from '../domain/viewport.js'
import { DEFAULT_THEME } from '../theme.js'
import type { Msg } from '../types.js'

const first = 'first request\nsecond line\nthird line\nfourth line\nfifth line'

const messages: Msg[] = [
  { role: 'user', text: first }, { role: 'assistant', text: 'first answer' },
  { role: 'user', text: 'next request' }, { role: 'assistant', text: 'next answer' }
]

const heights = [7, 8, 3, 6]
const offsets = [0, 7, 15, 18, 24]

interface Observed {
  changes: string[]
  geometry: Array<{ text: string; top: number; height: number }>
  scroll: { current: ScrollBoxHandle | null }
}

function Harness({ observed, tick = 0, height = 16 }: { observed: Observed; tick?: number; height?: number }) {
  const [sticky, setSticky] = useState('')
  const pane = useRef<Parameters<typeof measureElement>[0] | null>(null)

  const readingTop = () => {
    const scroll = observed.scroll.current

    if (!scroll) {return 0}

    return stickyPromptReadingTop(scroll.getScrollTop() + scroll.getPendingDelta(),
      scroll.getViewportHeight(), pane.current ? measureElement(pane.current).height : scroll.getViewportHeight(), scroll.isSticky())
  }

  const update = useCallback((text: string) => {
    if (observed.changes.at(-1) !== text) {
      observed.changes.push(text)
      observed.geometry.push({ text, top: observed.scroll.current?.getScrollTop() ?? 0,
        height: observed.scroll.current?.getViewportHeight() ?? 0 })
    }

    // A broken implementation can oscillate indefinitely; retain enough real frames to prove it.
    if (observed.changes.length < 20) {setSticky(text)}
  }, [observed])

  return (
    <Box flexDirection="column" height={height} ref={pane} width={80}>
      {sticky && <StickyUserPrompt cols={80} onJump={() => {}} t={DEFAULT_THEME} text={sticky} timestamps />}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
        <ScrollBox flexDirection="column" flexGrow={1} flexShrink={1} ref={observed.scroll} stickyScroll>
          <Box flexDirection="column">
            {messages.map((message, index) => (
              <Box height={heights[index]} key={index}><Text>{message.text}{index === 3 ? ` ${tick}` : ''}</Text></Box>
            ))}
          </Box>
        </ScrollBox>
        <StickyPromptTracker messages={messages} offsets={offsets} onChange={update} readingTop={readingTop} scrollRef={observed.scroll} />
      </Box>
    </Box>
  )
}

afterEach(() => vi.useRealTimers())

describe('sticky prompt layout stability', () => {
  it.each([12, 13, 14, 16])('settles at height %s when the next human message is lower in the viewport', async height => {
    vi.useFakeTimers()
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(stdout, { columns: 80, rows: 24, isTTY: false })
    Object.assign(stdin, { isTTY: false })
    stdout.on('data', () => {})
    const observed: Observed = { changes: [], geometry: [], scroll: { current: null } }

    const instance = renderSync(<Harness height={height} observed={observed} />, {
      stdout: stdout as NodeJS.WriteStream, stdin: stdin as NodeJS.ReadStream,
      stderr: stderr as NodeJS.WriteStream, patchConsole: false
    })

    try {
      await vi.advanceTimersByTimeAsync(1000)
      observed.scroll.current?.scrollToBottom()

      for (let frame = 0; frame < 10; frame++) {
        instance.rerender(<Harness height={height} observed={observed} tick={frame + 1} />)
        await vi.advanceTimersByTimeAsync(1000)
      }

      expect(observed.scroll.current?.getScrollHeight()).toBe(24)
      expect(observed.changes.length, JSON.stringify(observed.geometry)).toBeLessThanOrEqual(3)
      expect(observed.changes.at(-1), JSON.stringify({ frames: observed.geometry, top: observed.scroll.current?.getScrollTop(), viewport: observed.scroll.current?.getViewportHeight() })).toBe(first)
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  })
})
