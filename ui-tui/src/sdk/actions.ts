/**
 * App actions exposed to widgets — the bridge from a widget click to the
 * same code paths the composer uses (slash commands, session identity).
 * The main app registers the runner once it has a slash handler.
 */
import { useStore } from '@nanostores/react'

import { $uiState } from '../app/uiStore.js'

type SlashRunner = (cmd: string) => boolean

let runner: null | SlashRunner = null

/** Called by the main app with its live slash handler. */
export function setWidgetSlashRunner(fn: null | SlashRunner): void {
  runner = fn
}

/** Run a slash command as if typed (`/sessions <id>`, `/new`, …).
 *  Returns false when the app isn't ready or the command was rejected. */
export function runSlash(cmd: string): boolean {
  const text = cmd.trim()

  if (!runner || !text) {
    return false
  }

  try {
    return runner(text.startsWith('/') ? text : `/${text}`)
  } catch {
    return false
  }
}

/** Current session id (null before the first session attaches). */
export function getSessionId(): null | string {
  return $uiState.get().sid ?? null
}

/** React hook: current session id + busy flag, re-rendering on change. */
export function useSessionInfo(): { busy: boolean; sid: null | string } {
  const ui = useStore($uiState)

  return { busy: !!ui.busy, sid: ui.sid ?? null }
}
