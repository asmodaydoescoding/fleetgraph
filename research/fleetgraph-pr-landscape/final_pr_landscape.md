# FleetGraph Final PR — Research Landscape
> Papers and analysis informing the next contribution. Sourced from arXiv searches (2026-08-24) + prior scout runs. Filtered against the author's three stated acceptance criteria.

## Acceptance Criteria (from asmodaydoescoding's review)
1. Plugin owns only plugin data — no host lifecycle decisions
2. No API contract changes — additive only, existing integrations keep working
3. Incremental measured improvements, not rewrites disguised as passes

---

## Thread: Delegation Feasibility (STRONGEST CANDIDATE)

### 2608.17282 — DeAR: Decentralized Agentic Reasoning via Capability Grounding
https://arxiv.org/abs/2608.17282

**Relevance to FleetGraph:** Capability grounding before routing — DeAR specializes agents per-query by capability before dispatch. FleetGraph's `/match` endpoint already ranks by capability; delegation feasibility extends this from "who could do it" to "can this subtree absorb it."

**Implementation Note:** `can_delegate_to(graph, sender, recipient, contract)` in `fleet_graph_core.py` — walks recipient's subtree, checks depth against contract's max-depth, checks capabilities against roster. Purely additive: new helper function + optional `delegate_contract` payload field on POST /send (ignored by old clients). No protocol break.

### 2607.11138 — Formal Hierarchical Architecture with Stack-Based Execution and Lazy Discovery
https://arxiv.org/abs/2607.11138

**Implementation Note:** Stack-based depth enforcement maps directly onto contract max-depth checking — each hop pushes a frame, refusal when stack exceeds declared bound.

---

## Thread: Passive Awareness (STRONG CANDIDATE)

### 2607.28430 — AgentRadio: Passive Awareness for Long-Horizon Multi-Agent Collaboration
https://arxiv.org/abs/2607.28430

**Relevance:** Asynchronous message-passing with background mention-waiting — agents stay aware without interrupting work. 29.8-point gain on long-horizon tasks came from *mid-course correction*, which is exactly what FleetGraph's polling-based awareness can't deliver (4s transcript polls miss between-tick discoveries).

**Implementation Note:** A `/heartbeat` SSE or websocket endpoint alongside existing REST — bots push status transitions; deck view subscribes instead of refetching every 8s. Additive: old clients keep polling, new UI uses stream. Server cost bounded by connection count.

---

## Thread: Semantic Flow Policy (GOOD — needs author buy-in first)

### 2607.24625 — APPA: Agentic Permissions Policy Algebra for Taint Confinement
https://arxiv.org/abs/2607.24625

**Relevance:** Formal policy algebra for agent communication — labels + two-monoid model with proven confinement. FleetGraph's semantic flow idea (tag messages `data`/`instruction`/`status`/`escalation`/`delegate`, per-edge rules) is a lightweight cousin. APPA proves the formal approach scales; FleetGraph would use the pragmatic subset.

**Caution:** Adds a tag field to message payloads — borderline against criterion 2 unless tags ride in an optional envelope extension old consumers ignore. Needs his nod first.

---

## Verdict for final PR

**Delegation feasibility check is the winner:**
- Smallest diff, deepest value (turns the initiative ladder's central promise into verified routing)
- Zero protocol change (optional payload field)
- Lives entirely in plugin-owned data (graph topology)
- Directly answers a gap the README itself acknowledges ("split work downward" is semantic expectation, no structural enforcement)
- Testable hermetically like maintenance/

Second PR candidate ready if he wants more: heartbeat awareness (additive endpoint).
Semantic flow policy: park until direct conversation.
