# FleetGraph Synthesis — 2026-08-24

**Generated:** 2026-08-24
**Source:** FleetGraph codebase (branch `feat/maintenance-pruning-and-rotation`) + PR reply draft + issue #1 author comment
**Author comment:** asmodaydoescoding on issue #1 (thoughtful scope pushback)

---

## 1. What We Built and Why

The maintenance folder lives at `maintenance/` and closes two documented known limitations of FleetGraph v0.6.1 that the README had been carrying as deferred:

- **Profile deletion is a leaky operation.** Deleting a Hermes profile leaves stale entries in `fleet_graph.yaml`, peer relations, inboxes, and read watermarks forever. There was no cleanup path.
- **Inbox JSONL files grow unboundedly.** No cap, no rotation, no TTL. A bot that goes silent for months still has its full inbox sitting on disk.

The answer is a CLI tool — `fleet-maint` — with three subcommands:

| Command | Purpose |
|---|---|
| `prune` | Remove deleted profiles from topology, relations, inboxes, watermarks, and `_meta.profile_aliases`. One atomic write through `fleet_graph_core.save_graph`. |
| `rotate` | Cap every inbox at `FLEET_INBOX_MAX` (default 500) newest messages with an atomic temp-file rename. Clamps watermarks so unread badges stay correct. Dropped malformed lines even under cap. |
| `status` | Read-only health snapshot: stale profiles, per-inbox sizes, over-cap flags. |

All writes go through `fleet_graph_core.save_graph` — SSOT, validation, and atomic-rename guarantees inherited, never reimplemented.

**Tests:** 24/24 hermetic checks in `test_fleet_maint.py`. **Integration suite:** 26/26 still passes untouched. Two real bugs were caught by the tests and fixed during development (malformed-line handling during rotate, watermark clamping edge case).

The design intent is narrow and operator-controlled: `prune` is *opt-in CLI*, not a hook on profile deletion. An operator runs `--dry-run`, sees exactly what would go, and chooses. The default profile can never be pruned; unknown targets are refused.

---

## 2. The Author's Feedback and Our Response Strategy

asmodaydoescoding commented thoughtfully on three deferred decisions in the issue:

| # | Deferred decision | Author's position | Our stance |
|---|---|---|---|
| 1 | Profile deletion should auto-prune topology/inboxes/watermarks | Scope concern: plugin doesn't own profile lifecycle; "what if the profile comes back?"; alias ambiguity in `_meta.profile_aliases` | We concur the concern is real. Our tool is *operator-invoked*, not auto-magical — it doesn't hook profile deletion at all. The dry-run makes the "what if it comes back" concern visible before any touch. On aliases: we do clean up `_meta.profile_aliases` entries, but acknowledge the plugin can't know intent behind a deletion — that's why it's opt-in. We offered to tighten (e.g., `--confirm` flag beyond dry-run, or skip alias-mapped profiles) if the author wants it narrower. |
| 2 | Graph writes should gain ETags / optimistic concurrency | Conceded outright — a protocol change for the whole API surface is a migration, not a patch. Last-write-wins with "re-GET before PUT" is explicit and correct. The race only matters with simultaneous editors, which is rare. | Concur. Not worth relitigating a decision the author has already reasoned through. |
| 3 | Canvas perf beyond 26 nodes | Conceded — virtualizing a DAG layout is fundamentally harder than virtualizing a list; layout dominates, not rendering. 26 nodes is a verified lower bound, not an upper limit. True optimization is a rewrite, not a performance pass. | Concur. Ours is a maintenance folder, not a rewrite proposal. |

**The reply draft** (`research/pr_reply_draft.md`) concedes #2 and #3 cleanly, defends #1 on the opt-in/dry-run axis, and offers to tighten scope if the author wants it narrower. The core principle: the strongest PRs know where to stop arguing.

---

## 3. What's Still Open

### Unresolved
- **Issue #1 itself** — the author has not yet responded to the reply draft. The comment sits acknowledged but unanswered. We don't know if they'll accept the PR as-is, ask for scope changes, or decline.
- **Upstream PR status** — the branch `feat/maintenance-pruning-and-rotation` is local (tracked against a fork). There is no evidence of a real PR opened upstream. The research folder is untracked. This entire effort may be a local artifact that never leaves the machine.

### Known limitations (undisturbed)
- Last-write-wins on concurrent PUTs (issue #2) — conceded, not addressed.
- Canvas perf beyond 26 nodes (issue #3) — conceded, not addressed.
- No arxiv/research pipeline (`research/arxiv_digest.md` exists but is a partial failure — 3 of 4 queries timed out).
- Semantic-match quality tracks SOUL.md specificity — no augmentation for thin profiles.
- No fleet-level health dashboard, no episodic log of topology changes.

### The bigger picture
The maintenance folder closes two real, documented gaps with honest, well-tested code. But it sits in a repo where three deferred decisions have been open since v0.6.1, only two of which we're addressing (and one of those only partially, via opt-in CLI rather than the automatic cascade the README describes). The research folder has ideas for six more PRs (ETags, deletion cascade, SOUL augmentation, fleet health, episodic log, delegation contracts) — none of them started.

---

## 4. Should We Push Forward With the PR or Adjust Scope?

### Case for pushing forward
- The code works and the tests pass. 24/24 + 26/26 green is not nothing.
- We're closing real, documented limitations — not inventing scope.
- We're not touching hot paths, not changing the API contract, not making host-level lifecycle decisions. The surface area is small and safe.
- The author's feedback is thoughtful and mostly concurred. We're not arguing against the reviewer; we're explaining why our narrow tool doesn't violate their scope concern.
- If the author wants it narrower, we can tighten (--confirm flag, skip alias-mapped profiles). That's a small adjustment, not a rewrite.

### Case for holding
- The author hasn't responded. Pushing a PR into a reviewer's queue without acknowledgment can read as pressure.
- The research folder is untracked and may not be intended for commit. If this is meant to be a local synthesis exercise rather than an upstream contribution, shipping a PR would be the wrong move.
- Two of the three issues are conceded, not solved — a reviewer seeing a PR that says "we fixed your issues" while leaving two of them open might find that inconsistent.

### My read

The folder stands on its own merits regardless of whether it gets merged. It closes real limitations, tests pass, and the design respects the plugin's boundaries. The author's feedback is good and we've responded to it honestly in the draft.

**If the intent is upstream contribution:** post the reply, open the PR, and be ready to tighten scope (#1) on request. Don't fight on #2 or #3 — those are conceded and the author is right.

**If the intent is local synthesis only:** leave the branch as a local artifact, keep the reply draft as a record of how we'd respond, and move on to the next research tick. The code is there if anyone wants it later.

The honest answer: I don't know which intent holds here. The branch exists, the tests pass, the reply is drafted, and the author has commented. But there's no PR opened, no upstream engagement visible, and the research folder is untracked. That combination suggests this may be mid-thought rather than ready-to-ship.

The right next move is to ask — or, if asking isn't possible, to assume the safer path (local artifact, reply drafted, PR deferred until there's signal) and document that decision plainly.

---

*Synthesis by Lilith. Next tick: re-read codebase + digest, check whether the PR was opened, fold new state into the next synthesis.*
