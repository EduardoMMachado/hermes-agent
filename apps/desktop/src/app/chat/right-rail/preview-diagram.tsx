'use client'

import DOMPurify from 'dompurify'
import { ArrowLeft, Maximize2, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { useDiagramZoom } from '@/hooks/use-diagram-zoom'
import {
  canGoBack,
  currentEntry,
  type DiagramHistory,
  goBack,
  previousEntry,
  pushHistory,
  startHistory
} from '@/lib/diagram-history'
import { cn } from '@/lib/utils'

// Same module the main process renders with, so a link resolves identically on
// both sides. Pure and dependency-free; the precedent for reaching into
// electron/ from the renderer is pool-limits.
import { resolveDiagramLink } from '../../../../electron/plantuml-render'

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

interface RenderState {
  error?: string
  loading: boolean
  svg?: string
}

/** A PlantUML source, rendered on demand and navigable: clicking a link inside
 *  the drawing opens the diagram it points at, in this same pane, with a way
 *  back. The rendered SVG is never written to disk — the source is the only
 *  artefact. */
export function PreviewDiagram({ label, path }: { label: string; path: string }) {
  const { t } = useI18n()
  const copy = t.desktop
  const [history, setHistory] = useState<DiagramHistory>(() => startHistory(path))
  const [state, setState] = useState<RenderState>({ loading: true })
  const hostRef = useRef<HTMLDivElement | null>(null)
  const active = currentEntry(history) ?? path

  // A new file from outside the pane starts a new trail: "back" must never
  // jump to a drawing this journey did not pass through.
  useEffect(() => {
    setHistory(startHistory(path))
  }, [path])

  const render = useCallback(async (target: string) => {
    const renderPlantuml = window.hermesDesktop?.renderPlantuml

    if (!renderPlantuml) {
      // An older shell has no renderer at all. Say so plainly rather than
      // reporting it as a diagram that failed to draw.
      setState({ error: 'This Hermes build cannot render diagrams.', loading: false })

      return
    }

    setState(prev => ({ ...prev, loading: true }))

    const result = await renderPlantuml(target)

    setState({ error: result?.error, loading: false, svg: result?.svg })
  }, [])

  useEffect(() => {
    void render(active)
  }, [active, render])

  const clean = useMemo(
    () =>
      state.svg
        ? DOMPurify.sanitize(state.svg, {
            ADD_ATTR: ['target', 'xlink:href'],
            USE_PROFILES: { svg: true, svgFilters: true }
          })
        : '',
    [state.svg]
  )

  // PlantUML writes the diagram's pixel size into the root <svg> as an inline
  // `style="width:229px;height:366px"`, plus width/height attributes. Inline
  // style beats any class, so the drawing renders at its natural size, ignores
  // the fit, and the zoom has nothing to grow. Strip the sizing and keep the
  // viewBox: the box then comes from the wrapper the hook resizes, and the
  // vector re-lays out sharp at every scale.
  useEffect(() => {
    const svg = hostRef.current?.querySelector('svg')

    if (!svg) {
      return
    }

    svg.style.removeProperty('width')
    svg.style.removeProperty('height')
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  }, [clean])

  // The drawing's own dimensions, straight from the SVG.
  const natural = useMemo(() => {
    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(clean)
    const width = Number(box?.[1])
    const height = Number(box?.[2])

    return width > 0 && height > 0 ? { height, width } : null
  }, [clean])

  const zoom = useDiagramZoom(natural)

  // Intercept clicks on the diagram's own links. Delegated from the host so it
  // survives every re-render, and captured before the anchor's default, which
  // would try to navigate the whole pane to a file:// URL.
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a')

      if (!anchor) {
        return
      }

      const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || ''
      const next = resolveDiagramLink(active, href)

      if (!next) {
        // Not a diagram hop. Block it anyway: a file:// navigation would
        // replace the pane with a blank document and lose the trail.
        event.preventDefault()

        return
      }

      event.preventDefault()
      setHistory(prev => pushHistory(prev, next))
    }

    host.addEventListener('click', onClick)

    return () => host.removeEventListener('click', onClick)
    // `clean` is in here on purpose, not just `active`: on first paint the host
    // is empty (the render is still in flight) and the effect binds to a node
    // that later gets its children replaced wholesale. Without re-running when
    // the markup arrives, the listener can sit on a stale node and no click
    // ever reaches it.
  }, [active, clean])

  const back = previousEntry(history)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <Button
          className="h-7 gap-1 px-2"
          disabled={!canGoBack(history)}
          onClick={() => setHistory(prev => goBack(prev))}
          size="sm"
          title={back ? `Back to ${fileName(back)}` : undefined}
          variant="ghost"
        >
          <ArrowLeft className="size-4" />
          <span className="text-xs">Back</span>
        </Button>
        <span className="truncate text-xs text-muted-foreground" title={active}>
          {fileName(active)}
        </span>
        <Button
          className="ml-auto h-7 px-2"
          onClick={() => void render(active)}
          size="sm"
          title="Re-render"
          variant="ghost"
        >
          <RefreshCw className={cn('size-4', state.loading && 'animate-spin')} />
        </Button>
      </div>

      {state.error ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {state.error}
        </div>
      ) : (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- wheel zoom needs the whole surface; keyboard zoom is bound in the hook
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          onPointerCancel={zoom.endDrag}
          onPointerDown={zoom.onPointerDown}
          onPointerMove={zoom.onPointerMove}
          onPointerUp={zoom.endDrag}
          onWheel={zoom.onWheel}
          ref={zoom.paneRef}
        >
          {/* Absolutely positioned, NOT flex-centred: the hook's translate is
              the single source of position. Flex centring alongside it would be
              a second opinion on where the drawing sits, and the two fighting is
              what made the previous version unfixable in small steps. Size and
              position both arrive together in `contentStyle`. */}
          <div
            aria-label={label}
            className={cn(
              'absolute top-0 left-0 origin-top-left [&_a]:cursor-pointer [&_svg]:block [&_svg]:h-full [&_svg]:w-full',
              zoom.pannable && (zoom.dragging ? 'cursor-grabbing' : 'cursor-grab')
            )}
            dangerouslySetInnerHTML={{ __html: clean }}
            ref={hostRef}
            style={zoom.contentStyle}
          />
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-background/85 p-1 shadow-sm backdrop-blur">
            <Button
              className="size-7 p-0"
              disabled={!zoom.canZoomOut}
              onClick={zoom.zoomOut}
              size="sm"
              title={copy.zoomOut}
              variant="ghost"
            >
              <ZoomOut className="size-4" />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(zoom.scale * 100)}%
            </span>
            <Button
              className="size-7 p-0"
              disabled={!zoom.canZoomIn}
              onClick={zoom.zoomIn}
              size="sm"
              title={copy.zoomIn}
              variant="ghost"
            >
              <ZoomIn className="size-4" />
            </Button>
            <Button
              className="size-7 p-0"
              disabled={!zoom.isZoomed}
              onClick={zoom.reset}
              size="sm"
              title={copy.resetZoom}
              variant="ghost"
            >
              <Maximize2 className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
