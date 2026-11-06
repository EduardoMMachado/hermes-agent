import { EventEmitter } from 'events'

import { Box, forceRedraw, renderSync, Text } from '@hermes/ink'
import React, { useState } from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { TextInput } from '../components/textInput.js'
import type { InputCursorSnapshot } from '../components/textInput.js'

class FakeTty extends EventEmitter {
  chunks: string[] = []
  columns = 80
  rows = 24
  isTTY = true
  isRaw = false
  private pending: string[] = []
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.pending.shift() ?? null
  }
  send(chunk: string): void {
    this.pending.push(chunk)
    this.emit('readable')
  }
  setEncoding(): this {
    return this
  }
  setRawMode(mode: boolean): this {
    this.isRaw = mode

    return this
  }
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(String(chunk))
    cb?.()

    return true
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
  vi.stubEnv('TMUX', '')
  vi.stubEnv('TERM', 'xterm-256color')
  ;(process.stdout as { isTTY?: boolean }).isTTY = true
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  ;(process.stdout as { isTTY?: boolean }).isTTY = undefined
})

it.each(['WarpTerminal', 'iTerm.app'])(
  'keeps unacknowledged text visible during %s streaming redraws',
  async terminal => {
    vi.stubEnv('TERM_PROGRAM', terminal)
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const snapshot: React.RefObject<InputCursorSnapshot | null> = { current: null }
    const values: string[] = []
    const submitted: string[] = []

    let stream: () => void = () => {}

    let replace: (value: string) => void = () => {}

    function Harness() {
      const [value, setValue] = useState('')
      replace = setValue
      const [delta, setDelta] = useState(0)
      stream = () => setDelta(n => n + 1)

      return (
        <Box flexDirection="column">
          <Text>Streaming delta {delta}</Text>
          <TextInput
            cursorSnapshotRef={snapshot}
            onChange={next => {
              values.push(next)
              setValue(next)
            }}
            onSubmit={next => {
              submitted.push(next)
              setValue('')
            }}
            value={value}
          />
        </Box>
      )
    }

    const instance = renderSync(<Harness />, {
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeTty() as unknown as NodeJS.WriteStream
    })

    try {
      await tick()

      for (const ch of 'abc') {
        stdin.send(ch)
        await tick()
      }

      vi.advanceTimersByTime(16)
      // Echo abc is pending; d is already locally committed when it lands.
      stdin.send('d')
      await tick()
      await tick()
      expect(process.stdout.write).toHaveBeenCalledWith('d')

      // No further input or timer flush: repeated unrelated renders must not erase d.
      for (let delta = 0; delta < 5; delta++) {
        stream()
        await tick()
        await tick()
        stdout.chunks = []
        forceRedraw(stdout as unknown as NodeJS.WriteStream)
        const screen = stripAnsi(stdout.chunks.join(''))
        expect.soft(screen).toContain('abcd')
      }

      vi.advanceTimersByTime(16)
      await tick()
      await tick()
      stdin.send('\r')
      await tick()
      await tick()
      expect(values.at(-1)).toBe('abcd')
      expect(submitted).toEqual(['abcd'])
      stdout.chunks = []
      forceRedraw(stdout as unknown as NodeJS.WriteStream)
      expect(stripAnsi(stdout.chunks.join(''))).not.toContain('abcd')

      // Non-ASCII commits and in-line edits must still use the same live draft.
      for (const key of ['a', 'ç', 'ã', 'o', '\x1b[D', '\x7f', 'X', '\x05', 'z'.repeat(140)]) {
        stdin.send(key)
        await tick()
        stream()
        await tick()
        vi.advanceTimersByTime(4)
        await tick()
      }

      vi.advanceTimersByTime(16)
      await tick()
      await tick()
      const edited = 'açXo' + 'z'.repeat(140)
      stdout.chunks = []
      forceRedraw(stdout as unknown as NodeJS.WriteStream)
      expect(stripAnsi(stdout.chunks.join('')).replace(/[\r\n]/g, '')).toContain(edited)
      stdin.send('\r')
      await tick()
      await tick()
      expect(submitted).toEqual(['abcd', edited])

      // A real history/completion assignment still wins over pending local keys.
      for (const ch of 'abc') {
        stdin.send(ch)
        await tick()
      }

      replace('history-completion')
      await tick()
      await tick()
      vi.advanceTimersByTime(32)
      stream()
      await tick()
      await tick()
      stdout.chunks = []
      forceRedraw(stdout as unknown as NodeJS.WriteStream)
      expect(stripAnsi(stdout.chunks.join(''))).toContain('history-completion')
      stdin.send('\r')
      await tick()
      await tick()
      expect(submitted.at(-1)).toBe('history-completion')
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  }
)
