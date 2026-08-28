# FleetGraph ArXiv Scout — 2026-08-24 (Lilith direct run)

Searched by hand after the model switch. Papers are sparks, not specs.

## Thread: Hierarchical Orchestration

### 2608.14707 — Semantic Uncertainty-Guided Orchestration in Hierarchical Multi-Agent Systems (HASSUM)
https://arxiv.org/abs/2608.14707

**Relevance to FleetGraph:** Directly applicable. HASSUM estimates trust at the answer-semantics level (semantic entropy + density) and uses it to drive adaptive orchestration — verification, selective re-prompting, confidence-aware selection. FleetGraph's supervisor/subordinate DAG is exactly the architecture this assumes.

**Implementation Note:** The `/match` semantic routing endpoint could return a confidence signal alongside capability ranking; supervisors could use it to decide when to delegate vs. handle directly, and the graph UI could render low-confidence edges in warning color. Architecture-independent per the paper, so it slots into the existing plugin without protocol changes.

### 2607.11138 — A Formal Hierarchical Architecture for Agentic Orchestration with Stack-Based Execution and Lazy Discovery
https://arxiv.org/abs/2607.11138

**Relevance:** Formal model of hierarchical agent execution with lazy discovery — relevant to how FleetGraph resolves which bots exist and what they can do (`/roster`).

**Implementation Note:** Lazy discovery maps onto roster generation: derive capability docs on demand rather than eagerly. Could reduce `/roster` cost on large fleets.

### 2607.07666 — Hierarchical memory architecture overcomes context limits in long-horizon multi-agent modeling
https://arxiv.org/abs/2607.07666

**Relevance:** Long-horizon fleets hit context limits; FleetGraph bots with deep transcripts face the same wall.

**Implementation Note:** Maps to the Live drawer's transcript tailing — a hierarchical summarization layer could keep 4s-polling cheap while preserving older context in compressed form.

## Thread: Agent Communication

### 2607.28430 — AgentRadio: Passive Awareness for Long-Horizon Multi-Agent Collaboration
https://arxiv.org/abs/2607.28430

**Relevance:** Passive awareness = agents broadcasting state without explicit messages. FleetGraph's `/sessions/tail` activity snapshot is a primitive version of this.

**Implementation Note:** A lightweight heartbeat channel would let the deck view show "working" states without polling transcripts — cheaper than the current 8s overview refetch.

### 2606.05304 — What Should Agents Say? Action-state Communication for Efficient Multi-Agent Systems
https://arxiv.org/abs/2606.05304

**Implementation Note:** Informs the framed composer design (talk/delegate/supervisor) — which frame an agent should choose given action-state is exactly the question the message composer forces humans to answer manually; could be auto-suggested.

### 2604.02369 — Beyond Message Passing: A Semantic View of Agent Communication Protocols
https://arxiv.org/abs/2604.02369

**Implementation Note:** Semantic framing of protocols validates FleetGraph's inbox-only delivery boundary — communication as meaning-carrier rather than raw transport. Supports keeping live-turn boot out of UI clicks.

## Search notes
- Plain keyword queries work; `cat:` API-syntax queries return empty through the scraper.
- Rate limit survived this session: ~6 searches total, no 429.

---

# Scout Agent Findings (restored from deleg_13f39169/task-3)

16 papers across 4 topics; top priorities:

| Priority | Paper | ID | Why |
|----------|-------|----|-----|
| 🔴 High | Reward-Guided Autoregressive Graph Generation for Multi-Agent Communication Topology | 2608.20099 | Graph generation for agent comm topology — core FleetGraph problem |
| 🔴 High | GB-PANDAS: Affinity Scheduling Throughput Optimality | 1709.08115 | Multi-type task → multi-skilled server scheduling — inbox rotation theory |
| 🔴 High | Automated Multi-Source Debugging & NL Error Explanation for Dashboards | 2602.15362 | NL error explanation for operational dashboards |
| 🟡 Med | Shape Change Hierarchical Layout for DAG Comparison | 2406.05560 | DAG hierarchical layout — supervisor/subordinate topology |
| 🟡 Med | Equinox: Decentralized Scheduling for Orbital Intelligence | 2604.19958 | Adaptive work shedding for capacity-variable agents |
| 🟡 Med | -ACT: Verifiable Agentic Intent Control | 2608.21049 | Auditable multi-agent intent control |

Full abstracts were in the original 16KB report (overwritten during consolidation); IDs above are fetchable via arxiv_abstract.py.
