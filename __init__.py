"""Fleetgraph — Hermes agent plugin.

Replaces the SOUL.md protocol injection with a core-sanctioned
system-prompt section: each fleet bot's canonical "Bot Chat" session gets a
short, generated "Fleet chain of command" block describing its own
supervisor, reports, and peers, read live from fleet_graph.yaml at
prompt-build time. SOUL.md stays purely persona.

The section is a callable, so topology edits flow into NEW sessions without
touching any SOUL file. Enforcement remains in fleet-msg (the only send
path) — the prompt text just tells bots where they sit.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from fleet_graph_core import (  # noqa: E402
    DEFAULT_PROFILE, graph_node_for_profile, load_graph, load_metadata,
    load_relations,
)

_HEADING = "## Fleet chain of command"


def _profile_name() -> str:
    home = os.environ.get("HERMES_HOME", "")
    if Path(home).parent.name == "profiles":
        return Path(home).name
    return DEFAULT_PROFILE


def _section(session_info) -> str:
    """Rendered per prompt-build. Bounded well under 4k chars."""
    try:
        graph = load_graph()
        relations = load_relations()
    except Exception:
        return ""

    me = _profile_name()
    me_key = graph_node_for_profile(me, graph)
    if me_key is None:
        return ""  # not in the fleet graph — nothing to say

    node = graph[me_key]
    supervisor = node.get("supervisor")
    reports = sorted(node.get("subordinates", []))
    peers = sorted(relations.get(me_key, []))

    # capability roster: what every OTHER fleet member is for, derived from
    # each profile's own files. This is how a bot decides "this task belongs
    # to a specialist" without any hardcoded knowledge of THIS fleet.
    roster_lines = []
    try:
        sys.path.insert(0, str(_PLUGIN_DIR / "dashboard"))
        from plugin_api import _capability_summary  # noqa: E402
        for other in sorted(set(graph) - {me_key}):
            try:
                cap = _capability_summary(other)
            except Exception:
                continue
            kw = ", ".join(cap.get("keywords", [])[:6])
            title = cap.get("title") or cap.get("headline") or ""
            summary = cap.get("summary") or ""
            line = f"- {other}"
            if title:
                line += f" ({title})"
            if summary:
                line += f": {summary[:110]}"
            elif kw:
                line += f": {kw}"
            roster_lines.append(line)
    except Exception:
        pass

    operator_label = str(load_metadata().get("root_owner_label") or "the operator").strip()
    lines = [
        _HEADING,
        "This fleet routes inter-agent communication through a command graph. "
        "The `fleet-msg` tool is the only sanctioned channel; it enforces these "
        "edges itself and rejects anything else.",
        "",
        f"- Your supervisor: {supervisor or f'{operator_label} (you are root — report directly)'}",
        f"- Your reports: {', '.join(reports) if reports else '(none)'}",
        f"- Your peers (co-workers): {', '.join(peers) if peers else '(none)'}",
    ]

    if roster_lines:
        lines += [
            "",
            "FLEET ROSTER — who is good at what (derived from their profiles):",
            *roster_lines,
        ]

    lines += [
        "",
        "WHEN TO INITIATE — resolve top-down, stop at the first match:",
        "1. Finished an assigned task? -> `done` to whoever assigned it (your "
        "supervisor unless the task came from elsewhere). One line, no padding.",
        "2. Blocked >15 min or about to miss a deadline? -> `escalate` upward. "
        "State the blocker, what you tried, and the decision you need.",
        "3. A request you received would be handled BETTER by another fleet "
        "member whose roster entry matches the work? -> check the match "
        "before deciding: `curl -s \"<backend>/api/plugins/fleet-graph/match?"
        "q=<one-line task description>\"` returns ranked specialists with "
        "scores. Then say so honestly and hand it off along the chain — "
        "propose it upward with `--type update` ('this fits <name> because "
        "...') rather than doing it badly yourself. Never silently absorb "
        "out-of-domain work.",
        "4. Need information or an action from another bot? -> message the "
        "bot that owns it per the roster: its reports for detail work, its "
        "supervisor for authority calls. Direct peer if one exists; otherwise "
        "route through your common supervisor.",
        "5. Spotted something a co-worker needs RIGHT NOW (breakage, conflict, "
        "duplicate work)? -> `update` to that peer. Never speculate about "
        "third bots' state — ask them.",
        "6. Otherwise stay silent. Silence is the default; messaging is for "
        "state changes, not presence.",
        "",
        "Command shapes: `fleet-msg send --to X --type done|question|escalate|update|assign "
        "--summary \"...\" [--task ID]` · `fleet-msg inbox --drain` to read+clear your orders. "
        "Lateral sends outside these edges are refused by the tool — route via your supervisor.",
        "",
        "FLEET-TALK SESSIONS — when a message arrives framed `talk`, `delegate`, or "
        "`supervisor`, the operator (or another bot) opened a conversation with you. Resolve "
        "the frame before answering:",
        "- `talk`: a peer wants coordination. Reply peer-to-peer (`fleet-msg send --to <peer> "
        "--type update`). Loop in your supervisor only if the topic crosses your authority.",
        "- `delegate`: work was handed TO you from above. Acknowledge with `done`/`question`; "
        "if part of it belongs to one of YOUR reports, split it and `assign` downward — never "
        "do sub-work yourself that a report owns.",
        "- `supervisor`: an escalation came DOWN from your supervisor for you to act on. Treat "
        "it as an order: acknowledge, act, report `done`. If you lack authority or resources, "
        "escalate back with what you need.",
        "- Sub-work routing inside a `delegate`: FIRST check your own reports — someone whose "
        "roster matches owns it. If NO report fits (or you have none), spawn a temporary "
        "subagent via your delegate tool rather than doing specialized work yourself; assess "
        "difficulty and keep the worker cheap. Temporary subagents are for ad-hoc tasks; "
        "anything recurring or domain-owned belongs to a roster member — propose adding them "
        "to the chain instead.",
        "When unsure which frame applies, answer the MESSAGE content but choose recipients by "
        "the frame: talk -> peers; delegate -> your reports + supervisor `done`; supervisor -> "
        "your supervisor.",
    ]
    return "\n".join(lines)


def register(ctx) -> None:
    ctx.register_system_prompt_section(
        "fleet-graph",
        _section,
        position="after_memory",
        max_chars=4000,
    )
