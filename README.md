# Fleet Graph

The org chart **is** the interface. A Hermes desktop plugin that renders your
bot fleet's chain of command as an interactive graph, lets you rewire it live,
and tails each bot's activity without opening a single terminal.

![Fleet Command deck — light theme](docs/fleet-command-deck-light.png)
![Fleet Command graph — dark theme](docs/fleet-command-graph-dark.png)

## Features

- **Graph canvas** — layered DAG of supervisor/subordinate relations with
  peer edges drawn dashed. A fresh graph auto-fits all nodes; use **Fit** to
  recover after panning or zooming. Pan (drag), zoom (wheel, 0.4×–2× around
  the cursor), and click any bot to open its live transcript drawer. A valid
  operator viewport persists across sessions and is never overwritten by the
  mount default.
- **Deck view (v0.6.1 Fleet Command)** — team-grouped card deck: NEEDS
  ATTENTION triage pile, TEAMS (one header per supervisor with capability),
  UNASSIGNED with "attach under…" selects. Cards carry identity + capability
  line (from the roster), a status chip (`conversing` / `ready 2h` /
  `interrupted` / `idle`) and the unread pill. Clicking a card opens the
  **docked inspector** (slide-over on the graph canvas) with five tabs:
  **Live** (4s-polling transcript), **Inbox** (messages + mark-all-read),
  **Message** (framed composer — see below), **Configure**
  (supervisor/reports/peer editors), **SOUL** (editor). Search filters by
  name/title/capability keeping ancestor chains; status chips filter All /
  Conversing / Idle / Needs attention. The bottom save bar commits all draft
  edits as one atomic PUT.
- **Message composer (v0.6.1)** — open a framed conversation with any bot from
  its inspector: `talk` (bot → a peer; when it has several peers, pick the
  recipient — validated server-side against the peer list, so edges can't be
  faked), `delegate` (orchestrator → bot; the receiving bot splits work
  downward itself per the initiative ladder), `supervisor` (bot → its
  supervisor). Recipients resolve server-side from the live graph; empty text
  and unknown frames are refused (422). Delivery is inbox-only — no live-turn
  boot from UI clicks.
- **Live activity** — status dot per bot (`complete` / in-progress /
  `interrupted`) from its latest session, plus gateway-event pulses while a
  bot is actively working. The tail drawer polls the transcript every 4 s.
- **Inbox read-state** — unread badges computed against a per-profile
  watermark; click a badge or "Mark all read" to clear. New messages after
  marking correctly re-light the badge.
- **Rewire inline** — change supervisors, attach/detach reports, add/remove
  peer relations; draft edits save atomically via one PUT.
- **Create members** — full dialog mirroring Bots "New Agent": SOUL.md at
  birth, model picker, skills + toolsets checklists applied via
  profiles.configure.
- **SOUL editing** — per-bot SOUL.md editor (default profile protected).
- **Semantic routing** — `GET /api/plugins/fleet-graph/match?q=<task>&top=N`
  ranks the fleet by capability similarity (local fastembed embeddings,
  zero API cost). `GET /roster` exposes every bot's derived capability doc
  (title/summary/keywords/toolsets from profile.yaml + SOUL.md + config).
- **Discussion glow** — edges between bots that exchanged inbox messages in
  the last 5 minutes animate with flowing accent dashes (`/traffic` feed,
  polled every 5 s), in both graph and tree views.

## Initiative ladder (injected into every bot's system prompt)

The plugin's prompt section tells each agent where it sits in the chain and
gives it a 6-step initiative ladder: report done → escalate after >15 min
blocked → hand off out-of-domain requests upward with `/match` evidence →
route info/action needs by roster owner → update peers on urgent needs →
otherwise stay silent.

## Known limitations

- Profile **deletion does not prune** `fleet_graph.yaml`, inboxes, or
  watermarks — remove stale entries manually (or via a PUT) today.
- Concurrent graph PUTs are last-write-wins; persistence is atomic
  (temp-file + rename), but there is no merge. A partial PUT whose omitted
  relations reference removed nodes returns a clean 422 — send the full
  node set like the UI does. **External scripts doing read-modify-write
  PUTs must re-GET immediately before writing**, or they can clobber a
  concurrent UI save (drop nodes added in between).
- Backend edits (`plugin_api.py`) require an app restart; only the desktop
  frontend hot-reloads. The serve backend's port can change across
  restarts — resolve it from the process, don't hardcode it.
- SDK popup/portal components resolve the desktop app's `--color-*` token
  namespace; plugin-owned canvas and text styles resolve `--ui-*`. Custom host
  themes must expose both namespaces, as the desktop does.
- Semantic-match quality tracks SOUL.md specificity; canvas perf tested to
  23–26 nodes (~700ms mount), untested beyond.
- `/send` frames are an enum (`talk` / `delegate` / `supervisor`); the
  recipient for talk must be one of the target's declared peers.

## Install

1. Copy this folder into `~/.hermes/plugins/fleet-graph/` (backend) —
   already true if you're reading this in place.
2. Copy/symlink `~/.hermes/desktop-plugins/fleet-graph/plugin.js` if not
   already present (the desktop app watches that path).
3. Enable the plugin backend in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - fleet-graph
```

4. Reload desktop plugins (⌘K → "Reload desktop plugins"). If the dashboard
   service was running before install, restart it once so the Python API
   mounts (`systemctl --user restart hermes-dashboard.service`, or relaunch
   the desktop app).

## Configuration

Fresh installs start with an empty topology. Discovered profiles appear as
unassigned until the operator wires them; no developer fleet names or peer
relations are seeded.

Operator metadata lives beside the topology in `fleet_graph.yaml` and is not
returned as a graph node:

```yaml
_meta:
  profile_aliases:
    public-node-name: canonical-runtime-profile
  root_owner_label: Operator
```

Deployment and test environments may override the default runtime locations:

| Variable | Purpose |
|---|---|
| `FLEET_HOME` | Base Hermes/fleet home |
| `FLEET_GRAPH_PATH` | Topology YAML path |
| `FLEET_DEFAULT_PROFILE` | Canonical protected/default profile |
| `FLEET_INBOX_DIR` | Fleet inbox and watermark directory |
| `FLEET_PROFILES_DIR` | Hermes profiles directory |
| `FLEET_HERMES_BIN` | Hermes CLI executable |

## Permissions & data access

Read-only access to each profile's `state.db` (session titles/previews/
status via `hermes_state.SessionDB`), read/write to:

- `fleet_graph.yaml` — topology, peer relations, and operator metadata
- `~/.hermes/fleet-inbox/` — fleet message inbox and `.read/` watermarks
- `profiles/<name>/SOUL.md` — only when you edit a soul in the UI

No credentials are read, no network calls leave the machine.

## Internals

| Piece | Path | Role |
|---|---|---|
| UI | `desktop-plugins/fleet-graph/plugin.js` | Single-page plugin (Deck/Graph views, inspector, dialogs) |
| Backend | `dashboard/plugin_api.py` | FastAPI router mounted at `/api/plugins/fleet-graph/` |
| Core | `fleet_graph_core.py` | Topology SSOT: load/save/describe/simulate |
| Messaging | `fleet_msg.py` | CLI for inter-bot messages (powers the inbox) |
| Tests | `tests/public_integration_test.py`, `tests/` | Hermetic end-to-end integration suite plus static, configurability, adversarial backend, and nine frontend harnesses |

### Endpoints

| Route | Purpose |
|---|---|
| `GET /overview[?light=1]` | Full paint payload; `light=1` skips session DB reads |
| `GET /graph/summary` | Node/edge counts + status histogram (header strip) |
| `PUT /graph` | Replace topology + relations from editor drafts |
| `GET /relations` | Peer map |
| `GET /inbox/{p}` · `POST /inbox/{p}/read` | Inbox + watermark mark-read (supports `{ts}` / `{count}`) |
| `GET /soul/{n}` · `PUT /soul/{n}` | SOUL.md read/write (default profile blocked) |
| `GET /avatar/{n}` | Profile avatar as data URL |
| `GET /sessions/tail[?profile=p]` | Per-bot latest-session snapshot |
| `GET /sessions/{n}/messages?limit=` | Transcript tail for the live drawer |
| `POST /simulate` | Chain-of-command permission simulation |
| `GET /traffic?window=` | Recent inter-agent traffic for animated edge glow |
| `GET /roster` · `GET /match?q=&top=` | Capability roster and semantic routing |
| `POST /send` | Validated `talk` / `delegate` / `supervisor` inbox delivery |

## Development

Render harnesses (real React + stubbed SDK, drive every UI branch):

```bash
cd tests
[ -d node_modules ] || npm ci

node drive-harness.mjs     # expect: ALL BRANCHES DRIVEN
node hostile-harness.mjs   # expect: ALL HOSTILE BRANCHES DRIVEN
node loop2-harness.mjs     # create-dialog guards        (6 passed)
node loop5-harness.mjs     # optimistic-UI rollback      (4 passed)
node loop6-harness.mjs     # deck v2                     (15 passed)
node loop7-harness.mjs     # composer recipient contract (19 passed)
node loop8-harness.mjs     # release adversarial/state seams (25 passed)
node render-harness.mjs    # full render sweep           (ALL BRANCHES DRIVEN)
node boundary-harness.mjs  # error boundary              (caught + reload present)
```

Integration and backend suites:

```bash
python3 tests/public_integration_test.py       # hermetic end-to-end suite; expect INTEGRATION SUMMARY with 0 failed
python3 tests/backend_loop8_test.py            # expect 14/14
python3 tests/configurability_test.py          # expect 22/22
```

Static audit (parse, loader-import count, token/key hygiene):

```bash
python3 tests/a1_audit.py
# expect: PARSE OK · loader imports: 3 · token/key findings: 0
```

Design tokens live in one block (`TOKENS_CSS`) at the top of `plugin.js`,
derived from host theme tokens (semantic color vars, 150 ms fast / 300 ms
medium motion bands). Runtime literals are rejected by the configurability
gate.

## Deferred operator decisions

- Whether profile deletion should automatically prune topology, inboxes, and
  read watermarks.
- Whether graph writes should gain optimistic concurrency/ETags instead of the
  documented last-write-wins contract.
- Whether to optimize or virtualize the graph beyond the verified 26-node
  range.

## Loader constraint (for editors)

The desktop runtime loader scans plugin source with a naive regex that
treats the two module keywords followed by any quote as import specifiers.
Never write those keywords adjacent to quotes outside the real import
statements at the top of `plugin.js`. Verify after edits:

```bash
node --check desktop-plugins/fleet-graph/plugin.js
# loader regex sweep must report exactly the real imports:
grep -cE "(from|import)[\"']" desktop-plugins/fleet-graph/plugin.js || true
```
