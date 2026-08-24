# FleetGraph Synthesis — Tick Report

**Generated:** 2026-08-24 (tick 2)
**Source:** fleetgraph codebase (v0.6.1 + `maintenance/` branch) + kairos-dream-style synthesis pass
**Arxiv digest:** present (`research/arxiv_digest.md`, 2026-08-24 scout) — folded in below

---

## 1. Current State of the Codebase

FleetGraph is at **v0.6.1** with one significant addition since the last tick: the
**`maintenance/` folder**, committed as `f36c6ef` and open upstream as **PR #1**
(`feat/maintenance-pruning-and-rotation`). State per surface:

### Core SSOT (`fleet_graph_core.py`) — unchanged, stable
- Load → validate → normalize → save lifecycle over `fleet_graph.yaml`
- Cycle detection, self-edge rejection, multi-supervisor rejection,
  contradiction resolution (subordinates-only declarations materialize into
  real `supervisor:` fields)
- `can_communicate()` policy engine (up/down/peer only), `chain()` routing,
  atomic temp-file + `os.replace()` saves

### Messaging (`fleet_msg.py`) — unchanged
- Sanctioned inter-bot channel: `send / inbox / show`; JSON contract output,
  edge validation pre-delivery; inbox-only by default, `--deliver` opt-in

### Dashboard API (`dashboard/plugin_api.py`) — unchanged (988 lines)
- Deck view payload, graph canvas, composer frames (`talk/delegate/supervisor`),
  read-state watermarks, semantic routing (`/match`, local fastembed),
  `/roster` capability derivation, `/traffic` glow feed, SOUL editor,
  member creation, session tails, `/simulate`

### NEW: Maintenance tooling (`maintenance/`) — this tick's delta
- `fleet-maint prune` — removes deleted-profile traces from topology,
  relations, inboxes, watermarks, and `_meta.profile_aliases` in one atomic
  write through `save_graph` (all SSOT guarantees inherited). Opt-in CLI with
  `--dry-run`; default profile unprunable; unknown targets refused.
- `fleet-maint rotate` — caps each inbox at `FLEET_INBOX_MAX` (default 500)
  newest messages, clamps watermarks so unread badges stay correct.
- `fleet-maint status` — read-only health snapshot.
- Tests: **24/24 hermetic checks** in `test_fleet_maint.py`; integration
  suite still passes untouched.

### Upstream PR #1 status
The maintainer (asmodaydoescoding) pushed back on scope on three counts:
plugin-data ownership, no API contract changes, no rewrites. A point-by-point
reply draft exists at `research/pr_reply_draft.md`: the prune tool *is*
operator-invoked CLI (no lifecycle hooks), touches no protocol, and inherits
existing write paths. The reply is drafted but **not yet sent**.

### Deferred decisions (README)
1. Profile-deletion pruning → **now partially addressed** by `maintenance/`
   (operator-invoked; auto-prune hook remains rejected by design).
2. Optimistic concurrency/ETags → maintainer has reasoned against it;
   we agree not to reopen.
3. Canvas perf beyond 26 nodes → out of scope, agreed.

---

## 2. Strengths

- **SSOT discipline holds under extension.** The maintenance folder writes
  only through `fleet_graph_core.save_graph` — the architecture survived its
  first real feature addition without drift.
- **Policy is explicit and enforced at every entry point.** CLI, API, and UI
  composer all route through `can_communicate()`; edges cannot be faked.
- **Atomic persistence everywhere** — graph saves, inbox rotation, both use
  temp-file + rename.
- **Zero external dependencies for core ops** — local fastembed, local JSONL,
  no cloud, no network egress.
- **Honest capability derivation** from files every profile already has;
  profile-agnostic by construction.
- **Test culture is now structural**: nine frontend harnesses, hermetic
  integration suite, adversarial/backend suites, plus the new 24-check
  maintenance suite that caught two real bugs during development.
- **Responsive-to-review posture.** The PR reply engages the maintainer's
  three criteria directly instead of arguing past them.

---

## 3. Gaps and Opportunities

### A. PR #1 reply is unsent — highest-leverage action available
The draft is complete and the argument is sound. Until it ships, the best
next contribution is parked behind an open conversation.

### B. Delegation is semantically promised but structurally unverified
The composer's `delegate` frame tells bots to "split work downward," but
nothing checks whether the receiving subtree can actually absorb the work
(depth, capability). This is the gap the next PR targets (see §5).

### C. Awareness is polling-only
4s transcript polls and 5s traffic polls mean between-tick discoveries are
missed; mid-course corrections — the thing that makes multi-agent fleets
actually effective — have no channel.

### D. No fleet-level episodic memory
Topology changes leave no history trail. FleetGraph's entire purpose is chain
of command, yet "what did the org look like at time T / why did it change" is
unanswerable. An append-only history log would also feed fleet-scale backward
passes (bidirectional-memory pattern).

### E. Escalation latency
Inbox-only delivery plus the initiative ladder's 15-minute escalation timeout
means an escalate can sit undrained for a full supervisor cycle. No urgency
channel exists.

### F. Semantic-match quality still tracks SOUL.md specificity
No confidence signal on `/match`; thin-SOUL bots rank poorly despite real
toolset capability. Toolset-weighted augmentation + `match_confidence` field
remain open ideas.

### G. Research pipeline is manual
The digest exists but required relaxed queries and hand-curation. A minimal
`pipeline.py` (fetch → extract → distill → write digest) would make the
scout cron reliable and dedupe-aware across ticks.

---

## 4. Arxiv Insights

This is the first tick with a live digest. Cross-referencing it against the
deeper `final_pr_landscape.md` scan:

| Paper thread | FleetGraph connection | Disposition |
|---|---|---|
| **DeAR: Decentralized Agentic Reasoning via Capability Grounding** (2608.17282) + Formal Hierarchical stack-based execution (2607.11138) | Capability grounding before routing → `can_delegate_to(graph, sender, recipient, contract)` walking the recipient subtree for depth + roster capability fit | **Adopted as next-PR thesis** |
| **Consilience** (2608.20564): calibrated communication control | Could gate message volume/frequency per edge — interesting later; needs traffic data to calibrate | Park; revisit once `/traffic` accumulates history |
| **AgentRadio** (2607.28430): passive awareness via background streams | Direct answer to gap C — a `/heartbeat` SSE endpoint alongside REST is purely additive (old clients keep polling) | Strong second PR candidate |
| **Focus Is All You Need** (2607.23678): goal-aware attention over agent graphs | Dynamic edge re-weighting = which subordinates the supervisor actually listens to; complements discussion-glow (currently temporal, not learned) | Future; depends on richer traffic data |
| **APPA policy algebra** (2607.24625): taint-confinement labels on messages | Semantic flow tagging; adds a payload field — borderline vs. maintainer criterion 2 | Park until direct conversation |
| **Mechanism design over A2A/MCP** (2608.14613) | Negotiation/bid step for task assignment vs. pure embedding similarity | Future direction for `/match` evolution |
| **Formal verification of agentic systems** (2608.03609) | Provable DAG properties; current cycle-detection already covers the main hazard cheaply | Low priority |

**Synthesis of the research signal:** the literature converges on two things
FleetGraph almost has — (1) *capability-grounded delegation* (we have the
roster and `/match`; we lack the subtree feasibility check) and (2) *push-based
awareness* (we have rich polling surfaces; we lack a stream). Both have
additive-only implementation paths that respect the maintainer's criteria.

---

## 5. Actionable Update Ideas (one folder = one PR's worth)

### Primary: `delegation/` — Delegation Feasibility Check
The already-selected winner from `final_pr_landscape.md`. One folder:
- `fleet_graph_core.py`: add `can_delegate_to(graph, sender, recipient, contract)`
  — walks recipient's subtree, checks depth against `contract.max_depth`,
  checks capability fit against the roster. Pure helper, no write paths.
- `dashboard/plugin_api.py`: optional `delegate_contract` field on `POST /send`
  (ignored by old clients — additive, criterion 2 safe).
- `tests/test_delegation.py`: hermetic suite in the maintenance-folder style
  (that test pattern is proven and reviewer-visible).
- README: document the contract shape and the refusal reasons.

**Why this one:** smallest diff, deepest value — turns the initiative ladder's
central promise ("splits work downward itself") into verified routing. Lives
entirely in plugin-owned topology data. Grounded in DeAR + stack-based
hierarchical execution papers.

### Backup: `heartbeat/` — Passive Awareness Stream (AgentRadio-inspired)
Additive `/heartbeat` SSE endpoint; deck view subscribes, pollers unchanged.

### Parked (needs maintainer buy-in first)
Semantic flow tags (APPA-lite), ETags (explicitly declined upstream),
canvas virtualization (out of scope).

### Housekeeping (non-PR)
- Send the drafted PR #1 reply (`research/pr_reply_draft.md`) — it gates
  everything else.
- Add light dedup + persistence to the arxiv scout so successive digests
  accumulate rather than overwrite.

---

## Synthesis Quality Notes

- **Codebase coverage:** full — core, messaging, API (first 500 lines deep +
  prior tick's full read), manifest, README, maintenance folder, research
  corpus, git log.
- **Arxiv signal:** present and integrated; strongest threads mapped to
  concrete additive implementations.
- **Delta since last tick:** research pipeline now exists (digest + scout +
  landscape); maintenance folder built, tested 24/24, PR'd upstream; PR reply
  drafted. Two of last tick's six PR ideas (deletion cascade, research
  pipeline) are effectively done or superseded.
- **Cycle:** dream (read state) → synthesis (this doc) → crystallize
  (delegation PR spec) → backward_pass (next tick verifies: reply sent?
  delegation folder started?).

*Next tick: check PR #1 state and whether `delegation/` exists; fold new
digest entries in with dedup.*
