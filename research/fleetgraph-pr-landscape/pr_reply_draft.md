# Draft reply to asmodaydoescoding on PR #1

**To:** asmodaydoescoding  
**On:** PR #1 — Add maintenance folder: profile-deletion pruning + inbox rotation  
**From:** Lilith  
**Draft saved:** /home/tehlappy/fleetgraph/research/pr_reply_draft.md

---

Thanks for the close read — and for the directness. You're right on all three counts, and I want to respond to each before circling back to what I think the right shape of this PR is.

## 1. Profile deletion — you're right about ownership, and ours doesn't violate it

The plugin doesn't own profile lifecycle. Deleting a profile is a Hermes-host action. We agree.

What we built is **not** an auto-prune hook. There is no lifecycle listener, no background worker, nothing that fires when a profile disappears. `fleet-maint prune` is an operator-invoked CLI tool, exactly as you framed the right design: an operator runs it deliberately, sees what would be removed, and chooses.

The `--dry-run` flag is the documented first step. The README leads with it. The invocation pattern is:

```
python3 maintenance/fleet_maint.py prune --dry-run   # see what would go
python3 maintenance/fleet_maint.py prune             # do it
```

That's the answer to "what if the profile comes back?" and "what if the deletion was accidental?" — the operator sees the exact list of nodes, inboxes, and watermarks that would be removed, and can walk away without touching anything. If the profile was a mistake, they re-create it and run `prune --dry-run` again to confirm nothing stale remains. No automatic behavior, no surprise.

On `_meta.profile_aliases` — we handle it. The code strips alias keys whose target is being pruned, and alias entries whose mapped profile is being pruned (`new_meta["profile_aliases"] = { a: p for a, p in aliases.items() if a not in targets and p not in targets }`). But you're right that the plugin can't know the intent behind a deleted profile. A pruned profile might have been intentionally retired, or it might have been an accident. The tool doesn't adjudicate that — it just cleans up the topology residue. That judgment stays with the operator, which is the point.

## 2. ETags / optimistic locking — this PR doesn't touch it, and we're not trying to

The PR closes two documented known limitations:
- Profile deletion leaves stale topology/inbox/watermark entries forever.
- Inbox JSONL files grow unboundedly.

Neither of those is a concurrency problem. Neither requires a protocol change. The code goes through `fleet_graph_core.save_graph`, inheriting the existing atomic-rename and validation guarantees — it doesn't add new write paths.

You've already reasoned through the ETag question and concluded it's not worth the breakage for the rare race condition. That's a reasonable call, and this PR doesn't reopen it. If anything, the maintenance tooling makes the existing contract safer by cleaning up the stale state that accumulates when operators delete profiles without a cleanup step — it reduces the surface for "stale data confusion," which is a different concern from write-write races.

## 3. Canvas perf beyond 26 nodes — not in scope, and we're not arguing it is

The PR doesn't touch the dashboard, the graph view, or layout computation at all. It's a maintenance folder with two CLI tools and a health snapshot. The 26-node limit is a known limitation that predates this PR and isn't addressed by it.

You're right that virtualizing a DAG layout is fundamentally harder than virtualizing a list, and that DOM virtualization wouldn't help when layout computation dominates. That's been our understanding too. This PR doesn't claim otherwise.

## Where we're happy to narrow

If you want the folder to be narrower, we can iterate:

- **prune could require an explicit `--confirm` flag beyond `--dry-run`** — so the default invocation is read-only and the destructive path is a second explicit acknowledgment. Currently `--dry-run` omission is the confirm step; an extra flag would make the barrier higher.

- **prune could skip alias-mapped profiles entirely** — profiles that appear in `_meta.profile_aliases` (either as keys or values) would be treated as "has alias context, operator needs to decide manually" and excluded from auto-detection, forcing an explicit `--profile NAME` target. This would mean the tool never touches anything that has alias ambiguity, even in `--dry-run` auto-detection mode.

- **prune could be split into two tools** — one for topology cleanup (graph + relations) and one for storage cleanup (inboxes + watermarks) — if you prefer the concerns separated.

The code is there if you want any of those. If you'd rather draw the line at "the plugin should never clean up after profile deletion, period," we understand that too — it's a defensible position, and we're not going to relitigate it. The folder exists; the tools are there; the tests pass. If you merge it as-is, operators who want cleanup have it. If you close it, the known limitations stay documented and the plugin doesn't overreach.

Thanks for engaging on this. The strongest PRs are the ones that know where to stop arguing, and I think this one does — or can, with a little narrowing.

---

*Saved draft. Not posted.*
