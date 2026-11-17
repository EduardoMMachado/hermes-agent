// The customisation is generic: no file may name one company, project or machine.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Built from parts so this file does not match itself.
const FORBIDDEN = [new RegExp(['e', 'mana'].join(''), 'i'), /\/Users\/[^/\s]+/, /Projects\//]

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name === '__pycache__') return []
    const path = join(dir, e.name)
    return e.isDirectory() ? files(path) : [path]
  })
}

test('no file names a company, a user home or a machine-specific path', () => {
  const all = files(ROOT)
  assert.ok(all.length > 10)
  const hits = []
  for (const path of all) {
    const rel = path.slice(ROOT.length)
    for (const re of FORBIDDEN) {
      if (re.test(rel)) hits.push(`${rel} (path matches ${re})`)
      if (re.test(readFileSync(path, 'utf8'))) hits.push(`${rel} matches ${re}`)
    }
  }
  assert.deepEqual(hits, [])
})
