// IPC surface for rendering PlantUML sources into SVG for the preview pane.
// The rules (what is a diagram, where the render must run, what counts as a
// failure, how an in-diagram link resolves) live in plantuml-render.ts and are
// tested there; this owns the child process and the path hardening.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { ipcMain } from 'electron'

import { POSIX_SANE_PATH_ENTRIES } from './backend-env'
import { isPlantumlPath, isRenderError, plantumlArgs, renderCwd } from './plantuml-render'

export interface PlantumlIpcDeps {
  resolveRequestedPathForIpc: (value: string, options: { purpose: string }) => string
  expandUserPath: (value: string) => string
  findOnPath: (binary: string) => null | string
}

export interface PlantumlRenderResult {
  error?: string
  svg?: string
}

/** A diagram that takes longer than this is a runaway, not a slow render: the
 *  measured cost of the largest C4 source in the corpus is ~1.3s. */
const RENDER_TIMEOUT_MS = 30_000

/** PlantUML is graph layout — output grows with the diagram, not the source.
 *  Past this the pane would be rendering something nobody can read anyway. */
const MAX_SVG_BYTES = 24 * 1024 * 1024

let binaryCache: null | string | undefined

export function registerPlantumlIpc({ expandUserPath, findOnPath, resolveRequestedPathForIpc }: PlantumlIpcDeps) {
  const resolveBinary = () => {
    if (binaryCache === undefined) {
      binaryCache = findOnPath('plantuml')

      // A Finder/Dock launch inherits only /usr/bin:/bin:/usr/sbin:/sbin, which
      // is where Homebrew is NOT — so `plantuml` looks missing on a machine
      // that has it installed. Check the standard prefixes directly, the same
      // surface buildDesktopBackendPath hands the Python backend.
      if (!binaryCache) {
        for (const dir of POSIX_SANE_PATH_ENTRIES) {
          const candidate = path.join(dir, 'plantuml')

          if (fs.existsSync(candidate)) {
            binaryCache = candidate

            break
          }
        }
      }
    }

    return binaryCache
  }

  ipcMain.handle('hermes:plantuml:render', async (_event, filePath): Promise<PlantumlRenderResult> => {
    const requested = String(filePath || '').trim()

    if (!requested || !isPlantumlPath(requested)) {
      return { error: 'Not a PlantUML source.' }
    }

    const resolved = resolveRequestedPathForIpc(expandUserPath(requested), { purpose: 'Diagram preview' })
    const binary = resolveBinary()

    if (!binary) {
      // Say what is missing and how to get it. A bare failure here reads as a
      // broken diagram, and the user would go looking in the wrong place.
      return { error: 'PlantUML is not installed. Install it (brew install plantuml) to preview diagrams.' }
    }

    return new Promise<PlantumlRenderResult>(resolve => {
      // cwd is load-bearing, not tidiness: relative `!include` resolves against
      // the process directory, so rendering from anywhere else silently drops
      // the theme and emits an error card that still exits 0.
      const child = spawn(binary, plantumlArgs(), { cwd: renderCwd(resolved), stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let stderr = ''
      let size = 0
      let settled = false

      const finish = (result: PlantumlRenderResult) => {
        if (!settled) {
          settled = true
          resolve(result)
        }
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ error: 'Diagram render timed out.' })
      }, RENDER_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length

        if (size > MAX_SVG_BYTES) {
          child.kill('SIGKILL')
          finish({ error: 'Diagram is too large to preview.' })

          return
        }

        chunks.push(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(0, 2000)
      })

      child.on('error', err => {
        clearTimeout(timer)
        finish({ error: `Could not run PlantUML: ${err.message}` })
      })

      child.on('close', () => {
        clearTimeout(timer)

        const svg = Buffer.concat(chunks).toString('utf8')

        // Exit code is not evidence: PlantUML exits 0 and hands back a valid
        // SVG describing the syntax error. Judge the output.
        if (isRenderError(svg)) {
          finish({ error: stderr.trim() || 'The diagram could not be rendered.' })

          return
        }

        finish({ svg })
      })

      child.stdin.on('error', () => {
        // The child died before the source was written; `close` reports it.
      })

      // `-pipe` reads the source from stdin. Feeding the file through instead
      // of naming it on the command line is what lets cwd stay the file's own
      // folder (so `!include ../theme/…` resolves) while PlantUML still writes
      // the result to stdout rather than a file beside the source — the SVGs
      // are no longer artefacts we keep.
      fs.promises
        .readFile(resolved)
        .then((source: Buffer) => child.stdin.end(source))
        .catch((err: Error) => {
          child.kill('SIGKILL')
          finish({ error: `Could not read the diagram: ${err.message}` })
        })
    })
  })
}

/** Test seam: the binary lookup is cached for the process lifetime. */
export function resetPlantumlBinaryCache() {
  binaryCache = undefined
}
