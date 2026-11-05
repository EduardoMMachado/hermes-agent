/**
 * /pin — toggles the pin on a session. No argument: the current session; with an
 * argument: that session id. Runs `hermes sessions pin|unpin`, the same `pinned`
 * column the desktop app's Pinned section reads, so a pin made here shows there and
 * vice versa. Pinned sessions are always listed at the top of the side bar
 * (sidebar.mjs, FIXADAS section).
 */
import { execFile } from 'node:child_process'

import { isPinned } from './lib/data.mjs'

export default function register(sdk) {
  const { defineWidgetApp } = sdk

  const app = defineWidgetApp({
    id: 'pin',
    help: 'pin/unpin the current session in the side bar (toggle)',
    mode: 'modal',
    usage: 'usage: /pin [session-id]',
    // Side-effect command: the work happens in init, which returns null, so the
    // host opens nothing and prints `usage` — used here as the feedback line.
    init: arg => {
      const id = (arg || '').trim() || sdk.getSessionId()

      if (!id) {
        app.usage = '/pin: nenhuma sessão ativa ainda — mande uma mensagem primeiro'
        return null
      }

      const pinned = isPinned(id)
      execFile('hermes', ['sessions', pinned ? 'unpin' : 'pin', id], { timeout: 15000 }, () => {})
      app.usage = pinned ? '📌 sessão desafixada da barra lateral' : '📌 sessão fixada no topo da barra lateral'
      return null
    },
    reduce: state => state,
    render: () => null
  })
}
