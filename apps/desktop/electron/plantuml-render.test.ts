import { describe, expect, it } from 'vitest'

import { isPlantumlPath, isRenderError, renderCwd, resolveDiagramLink } from './plantuml-render'

const L2 = '/repo/architecture/c4/l2-container.puml'

describe('isPlantumlPath', () => {
  it.each(['/a/b.puml', '/a/b.PUML', '/a/b.plantuml', '/a/b.pu', '/a/b.iuml', '/a/b.wsd'])(
    'recognises %s',
    file => expect(isPlantumlPath(file)).toBe(true)
  )

  it.each(['/a/b.svg', '/a/b.md', '/a/b', '/a/puml', '/a/b.png'])('rejects %s', file =>
    expect(isPlantumlPath(file)).toBe(false)
  )

  it('does not treat a dotted directory as an extension', () => {
    expect(isPlantumlPath('/repo/v1.2/diagram')).toBe(false)
  })
})

describe('renderCwd', () => {
  // The whole reason this exists: PlantUML resolves `!include ../theme/x.puml`
  // against the process working directory, so a render started anywhere else
  // silently drops the theme.
  it('is the folder holding the source', () => {
    expect(renderCwd(L2)).toBe('/repo/architecture/c4')
  })

  it('handles a file at the root', () => {
    expect(renderCwd('/x.puml')).toBe('/')
  })
})

describe('isRenderError', () => {
  it('flags empty output', () => {
    expect(isRenderError('   ')).toBe(true)
  })

  // PlantUML exits 0 and hands back a perfectly valid SVG that happens to
  // describe the failure, so only the content can tell us.
  it('flags the in-band error card', () => {
    expect(isRenderError('<svg><text>Syntax Error?</text></svg>')).toBe(true)
    expect(isRenderError('<svg><text x="5">cannot include ../theme/x.puml</text></svg>')).toBe(true)
  })

  it('passes a real diagram', () => {
    expect(isRenderError('<svg><g><rect/><text>Platform API</text></g></svg>')).toBe(false)
  })

  it('does not flag a diagram that merely says the word error', () => {
    expect(isRenderError('<svg><text>error handling flow</text></svg>')).toBe(false)
  })
})

describe('resolveDiagramLink', () => {
  it('resolves a sibling diagram', () => {
    expect(resolveDiagramLink(L2, 'l3-platform-api.puml')).toBe('/repo/architecture/c4/l3-platform-api.puml')
  })

  it('resolves across folders, which is how a store opens its ERD', () => {
    expect(resolveDiagramLink(L2, '../data/erd-platform.puml')).toBe('/repo/architecture/data/erd-platform.puml')
  })

  it('resolves an absolute path unchanged', () => {
    expect(resolveDiagramLink(L2, '/other/x.puml')).toBe('/other/x.puml')
  })

  it.each(['https://example.com/x.puml', 'mailto:a@b.c', '#anchor'])('leaves %s to the browser', href =>
    expect(resolveDiagramLink(L2, href)).toBeNull()
  )

  // Links point at sources, never at rendered output — the SVGs are gone.
  it('ignores a link to a rendered file', () => {
    expect(resolveDiagramLink(L2, 'svg/l3-platform-api.svg')).toBeNull()
  })

  it('strips a fragment before resolving', () => {
    expect(resolveDiagramLink(L2, 'l3-map-api.puml#top')).toBe('/repo/architecture/c4/l3-map-api.puml')
  })

  // A link that climbs past the root is a broken diagram. Clamping it at `/`
  // would open some unrelated file and hide the break.
  it('refuses a link that escapes the root', () => {
    expect(resolveDiagramLink('/a/b.puml', '../../../etc/passwd.puml')).toBeNull()
  })

  it('refuses an empty href', () => {
    expect(resolveDiagramLink(L2, '   ')).toBeNull()
  })
})

// The regression this pins: previewKind is decided in TWO places — this
// predicate feeds the main process's normalizePreviewTarget (the preferred
// path) while the renderer keeps its own list for older shells. A source
// classified as text there renders as code, which is exactly what shipped.
describe('classification parity', () => {
  it('claims every extension the renderer fallback claims', () => {
    // Mirrors DIAGRAM_EXTENSIONS in src/lib/local-preview.ts.
    for (const ext of ['.iuml', '.plantuml', '.pu', '.puml', '.wsd']) {
      expect(isPlantumlPath(`/repo/diagram${ext}`)).toBe(true)
    }
  })

  it('leaves the other preview kinds alone', () => {
    for (const ext of ['.html', '.pdf', '.png', '.svg', '.md']) {
      expect(isPlantumlPath(`/repo/file${ext}`)).toBe(false)
    }
  })
})
