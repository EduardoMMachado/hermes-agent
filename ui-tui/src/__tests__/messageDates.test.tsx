import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import { stripAnsi } from '@hermes/shared/ansi'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { MessageLine } from '../components/messageLine.js'
import { DEFAULT_THEME } from '../theme.js'
import type { Msg } from '../types.js'

function paint(msg: Msg, live = false) {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(stdout, { columns: 100, rows: 30, isTTY: false })
  Object.assign(stdin, { isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })

  const instance = renderSync(React.createElement(MessageLine, {
    cols: 100, msg, isStreaming: live, timestamps: true, t: DEFAULT_THEME
  }), { stdout: stdout as NodeJS.WriteStream, stdin: stdin as NodeJS.ReadStream, stderr: stderr as NodeJS.WriteStream, patchConsole: false })

  instance.unmount()
  instance.cleanup()

  return stripAnsi(output)
}

describe('message date and time', () => {
  it('renders the stored timestamp on both incoming and outgoing messages', () => {
    const timestamp = new Date(2026, 10, 5, 13, 7, 42).getTime() / 1000

    for (const role of ['user', 'assistant'] as const) {
      expect(paint({ role, text: 'message', createdAt: timestamp })).toContain('[05/11/2026 13:07:42]')
    }
  })

  it('does not invent a historical timestamp when it is absent', () => {
    expect(paint({ role: 'assistant', text: 'old message' })).toContain('[horário não registrado]')
  })

  it('records an observed time for a live reply before persisted metadata arrives', () => {
    expect(paint({ role: 'assistant', text: 'streaming now' }, true)).toMatch(/\[\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\]/)
  })
})
