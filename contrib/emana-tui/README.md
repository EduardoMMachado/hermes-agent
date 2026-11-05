# emana TUI customisation

Fork-only. Everything that makes the Hermes TUI look and behave like VS Code for
the emana machines, kept in one versioned place:

| Path | What |
|---|---|
| `skins/vscode-modern.yaml` | VS Code "Dark Modern" skin |
| `tui-widgets/sidebar.mjs` | right side bar: pinned + recent sessions, cron jobs of every profile, live background activity, command hints (`/sidebar` toggles) |
| `tui-widgets/pin.mjs` | `/pin [session-id]` — toggles a session's pin (same `pinned` flag as the desktop app) |
| `tui-widgets/lib/data.mjs` | shared data layer (`state.db` read-only via `sqlite3`, `cron/jobs.json` of every profile) |
| `tui-widgets/disabled/tabs.mjs` | tab bar + breadcrumbs (`header` zone), off; move it up a level and fix its import to enable |
| `install.sh` | links the above into `$HERMES_HOME` and sets the `display.*` keys |

The widgets rely on the fork's TUI patches (`ui-tui/`): full-height side rails,
the `header` zone, and `sdk.runSlash` / `useSessionInfo` / `useLiveActivity`.

## Install / update

```bash
contrib/emana-tui/install.sh --dry-run   # show what would change
contrib/emana-tui/install.sh
```

Run it from the live checkout (`~/.hermes/hermes-agent`). Because the targets are
symlinks into this tree, `hermes update` keeps them current; no re-install needed.

## Editing

Edit the files here, not under `~/.hermes`: the symlinks point here, so an edit is
a change to the live git tree, and the nightly updater postpones on a dirty tree.
Commit it to the fork (`origin/main`). Open TUIs reload widgets on every file
change, so write a whole file at once (copy + `mv`), never in several partial edits.

Commands, file names and identifiers are English; on-screen labels are Portuguese
on purpose.
