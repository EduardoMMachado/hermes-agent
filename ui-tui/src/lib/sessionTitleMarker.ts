export interface SessionTitleState {
  blocked: boolean
  busy: boolean
  background: number
}

/** A completed foreground turn does not mean the session's background work ended. */
export function sessionTitleMarker({ blocked, busy, background }: SessionTitleState): string {
  if (blocked) {
    return '⚠'
  }

  if (busy) {
    return '⏳'
  }

  return background > 0 ? `◷ ${background} bg ·` : '✓'
}
