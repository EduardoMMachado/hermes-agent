# TUI side bar customisation

Fork-only. A VS Code style look for the Hermes TUI, kept in one versioned place: a skin, a right
side bar widget and a `/pin` command. Nothing in it is tied to a company, a project or a machine.
Everything optional is turned on by one local file, `$HERMES_HOME/tui-sidebar.json`.

| Path | What |
|---|---|
| `skins/vscode-modern.yaml` | VS Code "Dark Modern" skin with pastel accents and muted diff colors |
| `tui-widgets/sidebar.mjs` | right side bar: pinned + recent sessions, cron jobs of every profile, live background activity, account quotas, command hints (`/sidebar` toggles); plus the optional rows below |
| `tui-widgets/pin.mjs` | `/pin [session-id]` — toggles a session's pin (same `pinned` flag as the desktop app) |
| `tui-widgets/lib/data.mjs` | shared data layer (`state.db` read-only via `sqlite3`, `cron/jobs.json` of every profile) |
| `tui-widgets/lib/quota.mjs` | Claude/Codex account-wide weekly quota via `hermes usage --json --read-only`; shared five-minute cache, failures shown as unavailable |
| `tui-widgets/lib/config.mjs` | reads and validates `$HERMES_HOME/tui-sidebar.json` |
| `tui-widgets/lib/vertex.mjs` + `tui-widgets/bin/vertex_spend.py` | optional: this month's Vertex AI cost of one Google Cloud project (Google's token counts x your list prices); shared five-minute cache |
| `tui-widgets/lib/claudeapi.mjs` | optional: this month's Claude API cost of your Anthropic organization, as Anthropic bills it; ten-minute cache |
| `tui-widgets/lib/agents.mjs` | optional: a section listing the agents a command of yours reports as running |
| `tui-widgets/disabled/tabs.mjs` | tab bar + breadcrumbs (`header` zone), off; move it up a level and fix its import to enable |
| `tui-sidebar.example.json` | a complete example of the config file |
| `install.sh` | links the skin and widgets into `$HERMES_HOME` and sets the `display.*` keys |
| `tests/` | `node --test` suites for the widgets, a `unittest` suite for `vertex_spend.py` |

The widgets rely on the fork's TUI patches (`ui-tui/`): full-height side rails, the `header`
zone, and `sdk.runSlash` / `useSessionInfo` / `useLiveActivity`.

## Install / update

```bash
contrib/tui-sidebar/install.sh --dry-run   # show what would change
contrib/tui-sidebar/install.sh
```

Run it from the checkout Hermes runs from (normally `~/.hermes/hermes-agent`). It honours
`HERMES_HOME` (one profile at a time). Because the targets are symlinks into this tree,
`hermes update` keeps them current; no re-install is needed unless this directory moves.
Anything already at a target that is not our symlink is moved aside as `<name>.bak-<stamp>`.
The installer never writes `tui-sidebar.json`; it tells you where the example is.

## What the side bar shows

Always:

- **FIXADAS / SESSÕES** — pinned sessions, then the most recent ones; click to switch.
- **AGENDADOS** — cron jobs of the default profile and of every `profiles/*`; click a job for
  its last run.
- **EM EXECUÇÃO** — subagents, background processes and `/bg` prompts of this session.
- **CONSUMO DE LLM · CONTA** — the Claude and Codex weekly account quota with its renewal date
  (unknown reset timestamps are shown as unavailable, never guessed).
- Command hints; clicking one runs it.

Only when configured (see below): a running-agents section, a Vertex AI month-cost row and a
Claude API month-cost row. A section absent from the config is not shown at all; a section that
is present but malformed shows `config inválida` in its place.

## The config file

`$HERMES_HOME/tui-sidebar.json` (`HERMES_HOME` defaults to `~/.hermes`, so each profile has its
own). Start from the example:

```bash
cp contrib/tui-sidebar/tui-sidebar.example.json "${HERMES_HOME:-$HOME/.hermes}/tui-sidebar.json"
```

A missing file, or one that is not a JSON object, simply hides every optional row. Edits are
picked up on the next poll (about five seconds); no reload is needed. The file holds names and
prices only, never a secret.

### `vertexSpend` — this month's Vertex AI cost

```json
"vertexSpend": {
  "label": "Gemini",
  "project": "my-gcp-project",
  "currency": "USD",
  "inputPricePerToken": { "gemini-3.8-flash": 3e-07 },
  "keychain": { "service": "my-vertex-spend-sa", "account": "reader" },
  "priceSource": "Cloud Billing catalog, Vertex AI text input SKU"
}
```

| Key | Required | Meaning |
|---|---|---|
| `project` | yes | Google Cloud project id |
| `currency` | yes | ISO 4217 code of the prices; the amount is formatted in it |
| `inputPricePerToken` | yes | model id -> list price of one input token, in `currency` |
| `keychain` | one of these two | macOS login Keychain generic password holding the base64 of a service-account JSON key |
| `tokenFromGcloud` | | `true` to use your own `gcloud auth print-access-token` session instead |
| `label` | no | row label (default `Vertex`) |
| `priceSource` | no | free text recorded in the script's output |

How the number is made (`bin/vertex_spend.py`, read only, standard library only): Cloud Monitoring's
`aiplatform.googleapis.com/publisher/online_serving/consumed_token_throughput` summed over the
calendar month (this machine's time zone) per model. Google weights each token by its burndown
rate (for Gemini Flash models 1 input = 1, 1 cached input = 0.1, 1 output = 5, the same ratios as
their prices), so cost = weighted tokens x the input price. `token_count` (input/output) is read
too. A model without a configured price is reported as unpriced and left out, never estimated.
Taxes and credits are not included; the invoice is the source of truth.

Credential: give a dedicated service account only `roles/monitoring.viewer` on the project,
create a JSON key and store it base64-encoded in the login Keychain:

```bash
security add-generic-password -s my-vertex-spend-sa -a reader -w "$(base64 < key.json)"
```

The key never reaches argv, a file or the output: `openssl` signs the JWT from a pipe. Try it by hand:

```bash
python3 contrib/tui-sidebar/tui-widgets/bin/vertex_spend.py --config ~/.hermes/tui-sidebar.json
```

A failed reading prints `{"error": "<reason>", "estimate": true}` and exits 1; the row shows the
reason (`sem credencial no Keychain`, `sem permissão no Monitoring`, `Google Monitoring
indisponível`, `config inválida`, ...).

### `claudeApi` — this month's Claude API cost

```json
"claudeApi": { "keychain": { "service": "my-anthropic-admin-key", "account": "reader" }, "label": "API" }
```

The pay-per-token Claude API (not the subscription quota above): the calendar month's cost of the
whole Anthropic organization as Anthropic bills it, the post-discount, pre-credit amount in US$ from
the Usage and Cost Analytics API (`/v1/organizations/analytics/cost`). Anthropic refreshes that
export about every four hours, so the row says how recent the data is. It needs an **Admin** key
(a regular API key cannot read costs) stored in the named login Keychain item.

### `agents` — your own running agents

```json
"agents": {
  "title": "AGENTES",
  "command": ["python3", "-B", "/path/to/my_agents.py", "--json"],
  "refreshSeconds": 20,
  "roleLabels": { "review": "revisor" }
}
```

`command` is an argv (run without a shell, 15 s timeout) polled every `refreshSeconds` (default
20). It must exit 0 and print one JSON document:

```json
{"agents": [{"role": "dev", "card": "TASK-12", "title": "Fix login", "since": 1794921077,
             "seconds": 310, "alive": true, "stale": false}]}
```

| Field | Meaning |
|---|---|
| `role` | shown in the first column (`roleLabels` may rename it) |
| `card` | any task identifier, shown in the second column |
| `since` | unix seconds when the agent started; the time on the task ticks from it |
| `alive` | `false` = its process is gone (`✕`), `null`/absent = unknown |
| `stale` | `true` = its lease or heartbeat expired (`◷`) |
| `title`, `seconds` | optional, informational |

Rows without a string `role`/`card` or a numeric `since` are dropped. A non-zero exit or
unparsable output shows `sem leitura do comando`, never "no agents running". `title` (default
`AGENTES`) names the section.

## Other TUI behaviour of the fork

The terminal title distinguishes foreground processing (`⏳`), work still running in the
background (`◷ N bg ·`), and a fully idle session (`✓`). Finishing an agent response does not
mark the whole session complete while background work remains.

The most recent user request above the visible excerpt stays in a full-text band above the
transcript, including at the live response tail. This follows the reading context, not the
globally latest request of the session. Clicking jumps to that original; the band disappears once
it is visible. Visibility uses exact viewport coordinates, not the general eight-row buckets. All
lines, blank lines and indentation are preserved, including pasted input whose composer label is
compact. If the request exceeds the available reading space, its own scroll viewport exposes all of
it without hiding the conversation. While following the response tail, the reading anchor excludes
the band's own height. This prevents repeated showing and hiding when a later human message is
already visible. Manual scrolling still follows the actual viewport; the band and its click target
use the same reading anchor.

User and assistant messages show local date and time down to seconds. Persisted timestamps are
retained when reopening a session; live blocks use their first observed time before metadata
arrives. Missing historical timestamps are explicit, never replaced with the current time. The
installer enables `display.timestamps`.

Background completions and internal notifications keep their system-event origin, both live and
after reopening history. Queued inputs use the owner's display metadata matched by admission ID,
never a guess based on their text. These events do not replace the pinned human request; quoting a
notification remains human input.

Manual `/compress` reports waiting immediately and shows real elapsed waiting every 30 seconds. Its
RPC budget is 660 seconds, matching the CLI and Desktop; ordinary RPC deadlines are unchanged.
Repeating the command while awaiting its reply does not submit another compression. A transport
timeout means the result is unknown, not cancelled. For a legacy connection without a queryable
receipt, confirm completion before reopening the TUI to release that local duplicate guard.

## Editing and tests

Edit the files here, not under `~/.hermes`: the symlinks point here, so an edit is a change to the
live git tree, and an updater may postpone on a dirty tree. Open TUIs reload top-level widgets on
every file change, so write a whole file at once (copy + `mv`), never in several partial edits. The
host does not reload `lib/` modules by itself: when one changes, bump its `?v=N` import in
`sidebar.mjs`.

```bash
node --test contrib/tui-sidebar/tests/
python3 -m unittest discover -s contrib/tui-sidebar/tests -p 'test_*.py'
```

Commands, file names and identifiers are English; on-screen labels are Portuguese on purpose.
