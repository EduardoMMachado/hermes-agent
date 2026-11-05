/**
 * App actions exposed to widgets — the bridge from a widget click to the
 * same code paths the composer uses (slash commands, session identity).
 * The main app registers the runner once it has a slash handler.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $agentSnapshot, useAgentRoster } from '../app/agentRoster.js'
import { type ProcessRow, useProcessRows } from '../app/processRoster.js'
import { $uiState } from '../app/uiStore.js'
import { type AgentRow, buildAgentRows } from '../lib/agentRows.js'

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

export interface LiveActivity {
  /** Subagents + async delegations, in-flight first (same rows as the agents dock). */
  agents: AgentRow[]
  /** `/bg` prompts still running in this session. */
  bgTasks: string[]
  /** Background shell processes (`terminal(background=true)`), kept 60s after exit. */
  processes: ProcessRow[]
  /** Agents or processes still running. */
  running: number
}

/** React hook: everything running in the background of the current session.
 *  Ticks once a second while anything is live so elapsed times move. */
export function useLiveActivity(maxAgents = 8): LiveActivity {
  const subagents = useAgentRoster()
  const snapshot = useStore($agentSnapshot)
  const ui = useStore($uiState)
  const [now, setNow] = useState(Date.now)
  const processes = useProcessRows(now)
  const delegations = snapshot.sid === ui.sid ? snapshot.data.delegations : []

  const live =
    subagents.some(s => s.status === 'running' || s.status === 'queued') || processes.length > 0 || ui.bgTasks.size > 0

  useEffect(() => {
    if (!live) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [live])

  const agents = buildAgentRows(subagents, delegations, now, maxAgents)

  return {
    agents: agents.rows,
    bgTasks: [...ui.bgTasks],
    processes,
    running: agents.running + processes.filter(p => p.status === 'running').length
  }
}
