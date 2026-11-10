# emana TUI customisation

Fork-only. Everything that makes the Hermes TUI look and behave like VS Code for
the emana machines, kept in one versioned place:

| Path | What |
|---|---|
| `skins/vscode-modern.yaml` | VS Code "Dark Modern" skin with pastel accents and muted diff colors |
| `tui-widgets/sidebar.mjs` | right side bar: pinned + recent sessions, running pipeline agents, cron jobs of every profile, live background activity, command hints (`/sidebar` toggles) |
| `tui-widgets/pin.mjs` | `/pin [session-id]` — toggles a session's pin (same `pinned` flag as the desktop app) |
| `tui-widgets/lib/data.mjs` | shared data layer (`state.db` read-only via `sqlite3`, `cron/jobs.json` of every profile) |
| `tui-widgets/lib/quota.mjs` | Claude/Codex account-wide weekly quota via `hermes usage --json --read-only`; shared five-minute cache, failures shown as unavailable |
| `tui-widgets/lib/gemini.mjs` | this month's Gemini (Vertex) spend of the emana pipeline, an ESTIMATE from agy tokens x list price computed by `emana-brain/scripts/despachante/gemini_spend.py`; shared five-minute cache, failures shown as unavailable |
| `tui-widgets/lib/pipeline.mjs` | the emana pipeline's running agents (role, card, time on it) from `emana-brain/scripts/despachante/pipeline_agents.py`, polled every 20 s; a vanished process (✕) or expired lease (◷) is shown, a failed read is unavailable |
| `tui-widgets/disabled/tabs.mjs` | tab bar + breadcrumbs (`header` zone), off; move it up a level and fix its import to enable |
| `install.sh` | links the above into `$HERMES_HOME` and sets the `display.*` keys |

The widgets rely on the fork's TUI patches (`ui-tui/`): full-height side rails,
the `header` zone, and `sdk.runSlash` / `useSessionInfo` / `useLiveActivity`.

The terminal title distinguishes foreground processing (`⏳`), work still running
in the background (`◷ N bg ·`), and a fully idle session (`✓`). Finishing an agent
response does not mark the whole session complete while background work remains.

The most recent user request above the visible excerpt stays in a full-text
band above the transcript, including at the live response tail. This
follows the reading context, not the globally latest request of the session.
Clicking jumps to that original; the band disappears once it is visible.
Visibility uses exact viewport coordinates, not the general eight-row buckets.
All lines, blank lines and indentation are preserved, including pasted input
whose composer label is compact. If the request exceeds the available reading
space, its own scroll viewport exposes all of it without hiding the conversation.
While following the response tail, the reading anchor excludes the band's own
height. This prevents repeated showing and hiding when a later human message is
already visible. Manual scrolling still follows the actual viewport; the band and its click
target use the same reading anchor.

User and assistant messages show local date and time down to seconds. Persisted
timestamps are retained when reopening a session; live blocks use their first
observed time before metadata arrives. Missing historical timestamps are explicit,
never replaced with the current time. The installer enables `display.timestamps`.

Background completions and internal notifications keep their system-event origin,
both live and after reopening history. Queued inputs use the owner's display
metadata matched by admission ID, never a guess based on their text. These events
do not replace the pinned human request; quoting a notification remains human input.

Manual `/compress` reports waiting immediately and shows real elapsed waiting
every 30 seconds. Its RPC budget is 660 seconds, matching the CLI and Desktop;
ordinary RPC deadlines are unchanged. Repeating the command while awaiting its
reply does not submit another compression. A transport timeout means the result
is unknown, not cancelled. For a legacy connection without a queryable receipt,
confirm completion before reopening the TUI to release that local duplicate guard.

Each weekly account quota includes the provider's renewal date, time and local
UTC offset. Unknown reset timestamps are displayed as unavailable, not guessed.

Gemini is billed per use, so its row shows the calendar month's spend instead of a
weekly window. It is labelled as an estimate: the pipeline's agy runs priced at the
Vertex list price, without Gemini used outside the pipeline, taxes or credits.
Google's invoice is the source of truth.

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
