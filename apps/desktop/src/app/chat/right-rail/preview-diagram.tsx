'use client'

import DOMPurify from 'dompurify'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useImageZoom } from '@/hooks/use-image-zoom'
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

  // Vector source: the zoom scales layout rather than transform, so the
  // diagram stays sharp at any magnification.
  const zoom = useImageZoom(true, true)

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
  }, [active])

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
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
          onWheel={zoom.onWheel}
          {...zoom.containerProps}
        >
          <div
            aria-label={label}
            className="[&_a]:cursor-pointer [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: clean }}
            ref={hostRef}
          />
        </div>
      )}
    </div>
  )
}
