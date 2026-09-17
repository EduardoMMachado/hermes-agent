/** Rendering PlantUML sources for the preview pane.
 *
 *  Pure and path-only, so the rules are testable without spawning java: the
 *  caller owns the child process, this owns which file counts as a diagram,
 *  what arguments the renderer gets, and how a link inside a rendered diagram
 *  resolves back to a file on disk.
 */

/** Extensions PlantUML owns. `.puml` is what we author; the others are what
 *  the wider ecosystem emits and users still drop into the pane. */
const PLANTUML_EXTENSIONS = new Set(['.iuml', '.plantuml', '.pu', '.puml', '.wsd'])

export function isPlantumlPath(filePath: string): boolean {
  const match = /\.[^./\\]+$/.exec(filePath.trim())

  return match ? PLANTUML_EXTENSIONS.has(match[0].toLowerCase()) : false
}

/** Render arguments for a source file.
 *
 *  `-tsvg` because the preview zooms: an SVG re-lays out at any scale while a
 *  raster blurs (the same reason the zoom work kept vector sources on layout
 *  scaling). `-pipe` keeps the render in memory — no temp file to clean up,
 *  no collision when two panes render the same diagram at once.
 *
 *  Piping is only safe together with `renderCwd`. These diagrams carry
 *  `!include ../theme/emana-c4.puml`, which PlantUML resolves against the
 *  PROCESS working directory, not the source: piped from the wrong directory
 *  it emits an unthemed diagram with an error banner and still exits 0.
 *  Measured on architecture/c4/l2-container.puml — 568,849 bytes piped from
 *  the file's own folder, byte-identical to rendering it by path, against
 *  11,295 bytes of error card when piped from anywhere else.
 */
export function plantumlArgs(): string[] {
  return ['-tsvg', '-pipe', '-pipeNoStderr']
}

/** The directory a render must run from for relative `!include` to resolve. */
export function renderCwd(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')

  return cut <= 0 ? '/' : normalized.slice(0, cut)
}

/** True when the renderer's output is a usable diagram rather than PlantUML's
 *  in-band error card. PlantUML exits 0 and emits a valid SVG describing the
 *  failure, so the exit code cannot be trusted on its own. */
export function isRenderError(svg: string): boolean {
  if (!svg.trim()) {
    return true
  }

  // The error card is the only output carrying these markers together.
  return /<text[^>]*>[^<]*\b(?:syntax error|cannot include)\b/i.test(svg)
}

/** Resolve a link found inside a rendered diagram against the file that
 *  declared it.
 *
 *  Returns null for anything that is not a local diagram hop: absolute URLs
 *  belong to the browser, and a link that climbs out with `..` past the root
 *  is refused rather than guessed at. The result is always a `.puml`-family
 *  path — the diagrams link to sources, never to rendered output, because
 *  rendered output is no longer a file that exists.
 */
export function resolveDiagramLink(fromFile: string, href: string): null | string {
  const raw = href.trim()

  if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('#')) {
    return null
  }

  const [pathPart] = raw.split(/[#?]/)

  if (!pathPart || !isPlantumlPath(pathPart)) {
    return null
  }

  const base = pathPart.startsWith('/') ? [] : renderCwd(fromFile).split('/')
  const out: string[] = []

  for (const segment of [...base, ...pathPart.split('/')]) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      // Refuse rather than silently clamping at the root: a link that escapes
      // its tree is a broken diagram, and resolving it to something plausible
      // would hide that.
      if (!out.length) {
        return null
      }

      out.pop()

      continue
    }

    out.push(segment)
  }

  return out.length ? `/${out.join('/')}` : null
}
