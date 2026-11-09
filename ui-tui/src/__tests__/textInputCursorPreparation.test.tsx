import { EventEmitter } from 'node:events'

import type * as Ink from '@hermes/ink'
import { renderSync } from '@hermes/ink'
import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { TextInput } from '../components/textInput.js'

const barrier = vi.hoisted(() => ({ ready: true, events: [] as string[] }))

vi.mock('@hermes/ink', async importOriginal => {
  const actual = await importOriginal<typeof Ink>()

  return {
    ...actual,
    useCursorAdvance: () => {
      const advance = actual.useCursorAdvance()

      return Object.assign((dx: number, dy?: number) => {
        barrier.events.push('advance')
        advance(dx, dy)
      }, {
        prepare: () => {
          barrier.events.push('prepare')

          return barrier.ready
        }
      })
    }
  }
})

class FakeTty extends EventEmitter {
  columns = 80
  rows = 24
  isTTY = true
  isRaw = false
  private pending: string[] = []
  ref(): void {}
  unref(): void {}
  read(): string | null { return this.pending.shift() ?? null }
  send(value: string): void { this.pending.push(value); this.emit('readable') }
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value;

 return this }
  write(_value: string | Uint8Array, cb?: () => void): boolean { cb?.();

 return true }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
let oldTTY: boolean | undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
  vi.stubEnv('TERM_PROGRAM', 'WarpTerminal')
  vi.stubEnv('TERM', 'xterm-256color')
  vi.stubEnv('TMUX', '')
  oldTTY = process.stdout.isTTY
  Object.assign(process.stdout, { isTTY: true })
  vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    if (value === 'b') { barrier.events.push('raw-b') }

    return true
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Object.assign(process.stdout, { isTTY: oldTTY })
})

it.each([true, false])('respects the renderer caret barrier before raw echo (ready=%s)', async ready => {
  barrier.ready = ready
  const stdin = new FakeTty()
  const values: string[] = []

  function Harness() {
    const [value, setValue] = useState('')

    return <TextInput onChange={next => { values.push(next); setValue(next) }} value={value} />
  }

  const instance = renderSync(<Harness />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: new FakeTty() as unknown as NodeJS.WriteStream,
    stderr: new FakeTty() as unknown as NodeJS.WriteStream,
    patchConsole: false
  })

  try {
    await tick()
    stdin.send('a')
    await tick()
    vi.advanceTimersByTime(32)
    await tick()
    await tick()
    barrier.events = []
    vi.mocked(process.stdout.write).mockClear()
    stdin.send('b')
    await tick()
    await tick()
    expect(barrier.events).toEqual(ready ? ['prepare', 'raw-b', 'advance'] : ['prepare'])

    if (ready) {
      expect(process.stdout.write).toHaveBeenCalledWith('b')
    } else {
      expect(process.stdout.write).not.toHaveBeenCalledWith('b')
    }

    vi.advanceTimersByTime(32)
    await tick()
    await tick()
    expect(values.at(-1)).toBe('ab')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
