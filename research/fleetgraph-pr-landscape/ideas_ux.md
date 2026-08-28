# FleetGraph — UX / Observability Ideas

Generated each tick. Concrete, PR-sized feature ideas for what an operator of a bot fleet actually needs to *see* — especially at 2am when something is wrong.

---

## Idea 1: Fleet Activity Heatmap (time × bots)

### Concept

A new **Heatmap** view (toggled from the Deck/Graph segmented control) that renders a grid: rows = fleet bots, columns = time buckets spanning the last 2 / 6 / 24 hours. Each cell is colored by activity intensity in that bucket — a composite signal drawn from session starts, transcript message count, tool.start/complete events, and status transitions (idle→active→complete). A warm row = a busy bot; a cold stripe across an entire team = something went quiet simultaneously.

Above the grid, a thin timeline strip shows fleet-wide event density (all bots summed per bucket) so the operator can see "when did things happen?" at a glance. Clicking a cell filters the deck to that bot and that time window; clicking a row header opens the bot's inspector pinned to that bucket's session.

A small set of range chips (2h / 6h / 24h / custom) drives a new backend query parameter. The heatmap re-renders client-side from the same JSON shape regardless of range, so adding a wider window is a backend change + a chip.

### Files touched

| File | Change |
|------|--------|
| `dashboard/plugin_api.py` | New endpoint `GET /activity/heatmap?window=7200&bucket_sec=300` returning `{ buckets: [iso_start, ...], matrix: { botName: [count, ...] }, totals: { botName: n } }`. Aggregates from `SessionDB.list_sessions_rich` (session starts/completes, last_active) plus a lightweight scan of inbox message timestamps and the existing gateway-event aperture. Bucket width defaults to 5 min, tunable via `bucket_sec`. |
| `desktop-plugin/plugin.js` | New `HeatmapView` React component + a `useHeatmap(window, bucketSec)` query hook. Adds a third segment to the view switcher (`Deck` / `Graph` / `Heatmap`). Range chips, cell tooltip (bot, bucket start, count, dominant status), and click→filter behavior. Reuses existing `TOKENS_CSS` color scale via a new `--fg-heat-0..4` ramp derived from `--ui-yellow` → `--fg-danger`. |
| `fleet_graph_core.py` (if shared aggregation logic lands there) | Optional: a shared `activity_bucket_counts(profile, window_sec, bucket_sec)` helper so the CLI, the dashboard, and any future exporter use the same bucketing. |

### Operator pain it solves

- **"Is this normal?"** — a single glance shows whether a silent bot is an outlier or part of a fleet-wide quiet period.
- **"When did this start?"** — a cold stripe appearing at a specific bucket is a timestamp the operator can act on (check logs, rewire, message the bot).
- **"Which bot is burning cycles?"** — sustained warm rows flag bots that are active far more than their neighbors, a leading indicator of a stuck loop or an unintended recursive delegation.
- **2am triage** — the fleet-wide density strip tells you whether the problem is one bot or the whole chain went dark at once (e.g., a supervisor lost its connection, taking its reports with it).

---

## Idea 2: Situation Report — blocked-task & escalation digest

### Concept

A **Situation Report** panel — a collapsible strip below the header in Deck view (and a standalone panel in Graph view) — that synthesizes the fleet's *problems* into a prioritized, human-readable summary. It is not a filter; it is an answer.

The panel surfaces, in order:

1. **Interrupted bots, ranked by stuck duration** — bots whose latest session is `interrupted`, each annotated with "interrupted 14m ago" / "interrupted 2h ago" / "interrupted 1d ago". Bots interrupted longer than the initiative-ladder escalation threshold (15 min, from the README) get a distinct warning treatment.
2. **Recent escalations** — supervisor-frame inbox messages sent in the last N minutes/hours, shown as a small chain: `Scout → Quartermaster (escalated 8m ago)`. This makes the initiative ladder *visible* — currently the operator has no idea a bot escalated until they open that bot's inbox.
3. **Idle-bot warnings** — bots with no session in the last H hours, flagged if they have unread inbox messages (something was sent their way and they never picked it up).
4. **Unread pressure** — the existing unread badge math, but presented as a ranked list ("Quartermaster has 7 unread") rather than only as a chip on a card.

Each row is clickable → jumps to that bot's inspector (Deck or Graph, whichever is active) with the relevant tab open (inbox for escalations, live for interrupted sessions).

A companion backend endpoint computes this so the panel is one query, not a bunch of ad-hoc client logic:

`GET /fleet/digest?window=3600` → `{ interrupted: [{name, since_epoch, duration_label}], escalations: [{from, to, ts, age}], idle_warning: [{name, last_active_epoch, idle_label}], unread: [{name, count}] }`.

### Files touched

| File | Change |
|------|--------|
| `dashboard/plugin_api.py` | New endpoint `GET /fleet/digest` (with optional `window` param). Reads `_latest_session` for interrupted/idle detection, scans inboxes for `type: supervisor` messages within the window, and reuses `_unread_counts`. No new data — just a synthesized, ranked view over existing signals. |
| `desktop-plugin/plugin.js` | `SituationReport` component rendered in the Deck header strip (collapsible) and as a floating panel in Graph view. Consumes `/fleet/digest` via a new hook. Row click handlers that set `selected` + `tailOpen` + `inspectorTab` appropriately. Adds a "View full inbox" affordance on escalation rows. |
| `README.md` | Document the panel under Features; note the escalation visibility gap it closes. |

### Operator pain it solves

- **"What's actually wrong right now?"** — instead of scanning every card's status chip and every unread pill, the operator gets a ranked problem list in one place.
- **"Did any bot escalate?"** — currently invisible. The digest makes the initiative ladder's escalation step observable, which is critical for trusting that the ladder is actually firing.
- **"Who's been stuck the longest?"** — interrupted bots are currently all tagged the same; duration matters when you have three of them and can only act on one.
- **2am triage, degraded state** — when the fleet is large and the operator is tired, a synthesized "here are your 4 problems, in order" beats a raw topology with 20 chips to interpret.

---

## Idea 3: Fleet Timeline — correlated event stream

### Concept

A **Timeline** view — a single chronological stream of fleet-wide events, scrollable and filterable — that answers "what happened, and in what order?" across all bots. Currently, the operator can see each bot's live transcript in isolation, and can see inter-bot traffic as animated edge glows, but there is no unified, queryable history that connects the dots.

The timeline aggregates event types into one stream, newest-first by default with a toggle for oldest-first (for reconstructing a sequence leading up to a failure):

- **Session events** — session start, session complete (from `SessionDB` lifecycle), interrupted-state transitions.
- **Inter-bot messages** — every inbox message (from the jsonl inboxes), annotated with its frame (`talk` / `delegate` / `supervisor`) and a link to both sender and recipient.
- **Tool activity** — `tool.start` / `tool.complete` summary events (name of tool, duration if available) — currently these stream through `host.onEvent` but are not persisted into any queryable history.
- **Graph topology changes** — a lightweight log of `PUT /graph` calls (who changed what, when). Currently there is *no record* of rewires; if a bot mysteriously has no supervisor, the operator cannot tell when it was detached. Even a simple append-only JSONL of `{ts, op, path, before, after}` would close this gap.

The timeline is filterable by: bot (one or more), event type family (sessions / messages / tools / topology), and time range. Clicking an event opens the relevant context: a message event → the recipient's inbox tab; a session event → that bot's live transcript pinned to that session; a topology event → a small diff popover ("Scout was detached from Quartermaster").

A new backend endpoint serves it:

`GET /activity/timeline?from=&to=&limit=200&bots=&types=` → `{ events: [{ ts, type, bot, detail }] }`.

For tool events that currently exist only as ephemeral gateway events, the backend would need either (a) a small in-memory ring buffer of recent tool.start/complete events (since the dashboard already receives them via `host.onEvent`), or (b) a per-profile tool-activity log written alongside the inbox. Option (a) is the smaller first PR and covers "what was this bot doing in the last hour?"

### Files touched

| File | Change |
|------|--------|
| `dashboard/plugin_api.py` | New endpoint `GET /activity/timeline`. Aggregates from session DB (lifecycle), inbox jsonl (messages), and an optional in-memory recent-tool-event buffer (written by a new `record_tool_event(profile, event_type, detail)` helper that the dashboard calls when it receives `host.onEvent('tool.start')` / `tool.complete`). Optionally a tiny topology-change log appended on each successful `PUT /graph`. |
| `desktop-plugin/plugin.js` | `TimelineView` component + `useTimeline(params)` hook. Filter bar (bot multi-select from roster, type checkboxes, time range). Event row renderer with type-specific icons/colors and click→context behavior. A "follow the chain" affordance: when a `delegate` message is selected, additionally highlight the receiving bot's next session-start event in the same stream. |
| `plugin_api.py` (hook point) | Optional: a tiny `FleetEventLog` singleton (file-backed ring buffer, e.g. last 10k events) so tool events are queryable without a DB schema change. If the operator prefers zero new files, the first PR can scope tool events to the in-memory buffer only and surface the gap as a known limitation. |
| `README.md` | Document the Timeline view and the topology-log gap it begins to close. |

### Operator pain it solves

- **"Did A's delegation to B actually precede B's work?"** — the timeline correlates a `delegate` message event with the recipient's subsequent session start, which is impossible today without opening two inspectors and mentally aligning timestamps.
- **"When was this bot detached from its supervisor?"** — currently there is no record. Even a minimal topology-change log turns a mystery into a timestamped fact.
- **"What was the sequence of failures?"** — when three bots go interrupted in quick succession, the timeline shows their session events and any inter-bot messages between them in one scrollable view, replacing a tedious open-and-scan across inspectors.
- **Post-incident review** — after the 2am fire is out, the operator can read the timeline forward from the triggering event to understand what cascaded, instead of relying on memory.

---

## Inspiration note (arxiv, optional)

A quick search for "human oversight multi-agent systems monitoring" surfaced three recent papers (IDs 2606.17915, 2606.17789, 2606.04435). The general theme that carried over: operators of multi-agent systems need *summarized, actionable* views — not raw per-agent dumps — and that escalation/handoff visibility is a recurring gap. None of the three is a direct template; they mostly reinforced the direction already implied by FleetGraph's own initiative ladder (which currently has no UI surface for its escalation step).

---

*Overwrite each tick. Keep ideas concrete enough that a contributor can open a PR against them.*
