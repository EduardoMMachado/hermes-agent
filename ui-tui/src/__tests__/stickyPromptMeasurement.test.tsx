import { PassThrough } from 'node:stream'

import type * as Ink from '@hermes/ink'
import { renderSync, wrapAnsi } from '@hermes/ink'
import React from 'react'
import { expect, it, vi } from 'vitest'

import { StickyUserPrompt } from '../components/stickyUserPrompt.js'
import { DEFAULT_THEME } from '../theme.js'

vi.mock('@hermes/ink', async importOriginal => {
  const actual = await importOriginal<typeof Ink>()

  return { ...actual, wrapAnsi: vi.fn(actual.wrapAnsi) }
})

it('reuses full-request row measurement until the request or width changes', () => {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(stdout, { columns: 135, rows: 83, isTTY: false })
  stdout.on('data', () => {})
  const text = 'Synthetic full request **content** with spaces.\n'.repeat(1100)
  const onJump = vi.fn()

  const view = (cols = 135, request = text, createdAt = 1) => (
    <StickyUserPrompt cols={cols} createdAt={createdAt} onJump={onJump} t={DEFAULT_THEME} text={request} timestamps />
  )

  vi.mocked(wrapAnsi).mockClear()

  const instance = renderSync(view(), {
    stdout: stdout as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream,
    patchConsole: false
  })

  try {
    expect(wrapAnsi).toHaveBeenCalledExactlyOnceWith(text, 133, { hard: true, trim: false })

    for (let tick = 0; tick < 10; tick++) {instance.rerender(view(135, text, tick + 2))}
    expect(wrapAnsi).toHaveBeenCalledTimes(1)
    instance.rerender(view(60))
    expect(wrapAnsi).toHaveBeenLastCalledWith(text, 58, { hard: true, trim: false })
    expect(wrapAnsi).toHaveBeenCalledTimes(2)
    instance.rerender(view(60, text + 'Full request tail remains available'))
    expect(wrapAnsi).toHaveBeenCalledTimes(3)
    // Terminal height remains live; changing it does not invalidate width-based wrapping.
    Object.assign(stdout, { rows: 24 })
    instance.rerender(view(60, text + 'Full request tail remains available', 99))
    expect(wrapAnsi).toHaveBeenCalledTimes(3)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
