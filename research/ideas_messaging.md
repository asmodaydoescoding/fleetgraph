# FleetGraph Messaging — Improvement Ideas

**Generated:** 2026-08-23  
**Scope:** Inter-bot communication layer (`fleet_msg.py` + `plugin_api.py` + inbox schema)  
**Constraint:** Every idea must keep existing inboxes parseable by current consumers.

---

## Idea 1: Message Priority Tiers with Urgency-Aware Delivery

### Concept

Today every message is equal — an `escalate` and an `update` land in the inbox with the same weight, and the only way to force immediate attention is the blocking `--deliver` flag (which boots a full agent turn and can take minutes). Add a **priority tier** to the message schema so senders can express urgency without paying the live-turn cost.

Three tiers:

| Tier | Token | Semantics |
|------|-------|-----------|
| `normal` | default | Land in inbox; draining bot picks it up on routine. |
| `high` | `--priority high` | Same inbox path, but the record carries a flag that the draining bot's prompt can surface as "needs prompt attention." |
| `urgent` | `--priority urgent` | Inbox + **optional light nudger**: if the target has an active session, append a one-line pointer to its running transcript (non-blocking, seconds not minutes). Never a full agent boot. |

The `--deliver` flag remains the nuclear option (full live turn). Priority tiers are a middle ground between "drop in inbox" and "boot the target."

The inbox record gains a `priority` field. Consumers that don't understand it see `normal`-equivalent behavior (forward-compatible).

### Files Touched

- **`fleet_msg.py`** — `cmd_send` gains `--priority` (choices: `normal`, `high`, `urgent`), validated enum. Header banner reflects tier. Urgent path: check `sessions/tail` for active session on target, append pointer line if found (best-effort, never fails the send).
- **`dashboard/plugin_api.py`** — `FleetSend` model gains `priority: str = "normal"` (validated against the same enum). `/send` stores it in the record.
- **`fleet_graph_core.py`** — no changes (policy layer is orthogonal to priority).
- **Inbox JSONL schema** — new optional `priority` key. Absent key == `normal`.

### Backward-Compatibility Note

Existing inboxes have no `priority` field. Any consumer that reads `rec.get("priority")` with a default (e.g. `rec.get("priority", "normal")`) keeps working unchanged. The fleet-msg CLI's `cmd_inbox` path already does `json.loads` and returns raw dicts — no schema enforcement, so old records parse fine. The only risk is a consumer that does `priority = rec["priority"]` (key error on old records); that's a consumer bug, not a protocol break, and the fix is to use `.get()` with a default.

---

## Idea 2: TTL / Expiry on Stale Messages

### Concept

Inbox rotation (`fleet-maint rotate`) caps file size by line count, but it doesn't expire messages by age. A bot that went silent six months ago still has its full inbox sitting on disk, and a supervisor draining on routine sees ancient context that may no longer be relevant. Add a **time-to-live** so messages self-expire.

Two mechanisms:

1. **Per-message TTL** — `send` gains `--ttl 3600` (seconds from send time). The inbox record gets an `expires_at` epoch-second field. When a consumer drains its inbox, it can skip records whose `expires_at` has passed. The record stays on disk until the next rotation pass.

2. **Stale-message purge** — a new `fleet-maint expire` subcommand scans every inbox, removes records past their `expires_at` (or past a global `--before` cutoff for messages without an explicit TTL), and clamps watermarks. Respects the atomic temp-file + rename pattern already used by `rotate`.

Default TTL: none (messages are durable unless the sender asks for expiry). This keeps the current "inbox is a durable log" semantics as the default path.

### Files Touched

- **`fleet_msg.py`** — `cmd_send` gains `--ttl` (integer seconds, optional). Record computed as `ts_epoch + ttl`. Stored as `expires_at` epoch-second in the JSON record.
- **`dashboard/plugin_api.py`** — `/send` accepts optional `ttl` in the `FleetSend` model; computes `expires_at` from `ts` + `ttl`.
- **`fleet_maint.py`** (maintenance) — new `expire` subcommand: `--dry-run`, `--before <epoch>` (global cutoff for messages without TTL), `--ttl <seconds>` (treat messages without explicit TTL as if sent ttl seconds ago). Purges expired lines, rewrites inbox atomically, clamps watermarks like `rotate` does.
- **Inbox JSONL schema** — new optional `expires_at` key. Absent key == no expiry (durable).

### Backward-Compatibility Note

Old inbox records have no `expires_at`. A consumer that does `expires_at = rec.get("expires_at")` with a default of `None` (meaning "never expires") keeps working. The `expire` command treats records without `expires_at` as durable unless a `--before` cutoff is supplied — so an operator can still bulk-clear ancient inboxes even for messages sent before TTL existed. The fleet-msg `cmd_inbox` path returns raw dicts; old records parse unchanged.

---

## Idea 3: Threaded Replies and Conversation Tracking

### Concept

Today, replies are just new messages in the inbox with no link to the message they're answering. A supervisor draining a subordinate's inbox sees a flat list of `question` / `update` / `done` records with no concept of "this is a reply to that." Add **threading** so conversations can be traced.

Two fields:

1. **`thread_id`** — a message can declare a thread it belongs to. If omitted, the message starts a new thread (its own `msg_id` becomes the thread root). A reply to an existing message carries that message's `thread_id`.

2. **`in_reply_to`** — optional reference to the specific message this is answering (by its `msg_id`). Lets a draining bot see "this `done` is the answer to that `question`."

Id generation: `fleet-msg send` generates a `msg_id` (ULID or timestamp-counter, e.g. `20260823T123456Z-001`) and stores it in the record. The `--reply-to` flag takes a `msg_id` and derives `thread_id` + `in_reply_to` from the target inbox's record. If `--reply-to` points to a message in a different inbox (e.g. replying to a message you received), the thread crosses inboxes — both sides see the same `thread_id`.

This turns the inbox from a flat log into a set of interleaved conversational threads. Draining bots can group by `thread_id` to see a conversation's full arc.

### Files Touched

- **`fleet_msg.py`** — `cmd_send` gains `--reply-to MSG_ID` (optional). When set, looks up the referenced message in the sender's own inbox (or the target's, if cross-inbox), derives `thread_id`, stores `in_reply_to`. `cmd_send` always writes a `msg_id` into the record (generated even when `--reply-to` is absent, so every message is addressable). `cmd_inbox` output includes `msg_id` and `thread_id`.
- **`dashboard/plugin_api.py`** — `/send` writes `msg_id` (generated server-side) and optional `in_reply_to` / `thread_id` from the `FleetSend` model. `/inbox/{profile}` returns records with these fields. A new query param `?thread=<thread_id>` filters to one conversation.
- **Inbox JSONL schema** — new `msg_id` (always present going forward), `thread_id` (always present), `in_reply_to` (optional). For backward compat, a reader that doesn't understand these fields ignores them. The `msg_id` field is new and always written by new sends; old records won't have it, but that's fine — they're still valid messages, just not addressable.

### Backward-Compatibility Note

This is the most invasive of the three ideas because it adds required fields (`msg_id`, `thread_id`) to new records. However:

- Old inbox records simply lack these keys. A consumer that does `msg_id = rec.get("msg_id")` with a fallback (e.g. `rec.get("msg_id") or f"legacy-{rec.get('ts')}"`) keeps working. The fleet-msg `cmd_inbox` path returns raw dicts — no schema enforcement.
- New records always have `msg_id` and `thread_id`. A consumer that requires them and refuses to parse records without them would break on old inboxes — that's a consumer migration path, not a protocol break, and it's acceptable because the protocol version moves forward.
- Cross-inbox threading (replying to a message in another bot's inbox) requires reading that inbox. The `--reply-to` lookup in `fleet_msg.py` can read the target inbox file directly (it's a local JSONL). The API path can read via `_read_inbox`. Both are already available.

---

## Summary

| # | Idea | Primary Gap | Inbox Schema Change |
|---|------|-------------|---------------------|
| 1 | Priority tiers + urgency-aware delivery | All messages equal; only `--deliver` forces attention | `priority` (optional, default `normal`) |
| 2 | TTL/expiry + stale-message purge | Inboxes grow unboundedly by age, not just count | `expires_at` (optional, absent = durable) |
| 3 | Threaded replies + conversation tracking | Flat log with no reply linkage | `msg_id` (always), `thread_id` (always), `in_reply_to` (optional) |

All three are independently mergeable. Idea 3 has the widest backward-compat surface (new required fields), but the migration path is a one-time `.get()` with fallback in consumers.
