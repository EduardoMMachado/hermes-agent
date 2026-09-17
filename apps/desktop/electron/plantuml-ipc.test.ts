import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { POSIX_SANE_PATH_ENTRIES } from './backend-env'

/** The lookup the IPC handler performs, mirrored so the fallback can be tested
 *  without spawning Electron. */
function resolvePlantumlBinary(onPath: null | string, exists: (candidate: string) => boolean): null | string {
  if (onPath) {
    return onPath
  }

  for (const dir of POSIX_SANE_PATH_ENTRIES) {
    const candidate = path.join(dir, 'plantuml')

    if (exists(candidate)) {
      return candidate
    }
  }

  return null
}

describe('locating the plantuml binary', () => {
  // The regression this pins: a Finder/Dock launch inherits only
  // /usr/bin:/bin:/usr/sbin:/sbin, so a Homebrew install is invisible and the
  // pane reported "PlantUML is not installed" on a machine that has it.
  it('finds a Homebrew install when PATH does not carry it', () => {
    const found = resolvePlantumlBinary(null, candidate => candidate === '/opt/homebrew/bin/plantuml')

    expect(found).toBe('/opt/homebrew/bin/plantuml')
  })

  it('prefers whatever PATH already resolved', () => {
    expect(resolvePlantumlBinary('/custom/plantuml', () => true)).toBe('/custom/plantuml')
  })

  it('reports nothing when the binary is genuinely absent', () => {
    expect(resolvePlantumlBinary(null, () => false)).toBeNull()
  })

  it('covers the Intel Homebrew prefix too', () => {
    const found = resolvePlantumlBinary(null, candidate => candidate === '/usr/local/bin/plantuml')

    expect(found).toBe('/usr/local/bin/plantuml')
  })

  // Not a mock: if this machine has plantuml, the fallback must actually find
  // it, because that is the failure the user hit.
  it('locates the real binary on this machine when present', () => {
    const real = ['/opt/homebrew/bin/plantuml', '/usr/local/bin/plantuml'].find(p => fs.existsSync(p))

    if (!real) {
      return
    }

    expect(resolvePlantumlBinary(null, p => fs.existsSync(p))).toBe(real)
  })
})
