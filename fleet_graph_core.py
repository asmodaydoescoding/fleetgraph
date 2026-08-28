#!/usr/bin/env python3
"""fleet-graph — hierarchical communication layer for the Hermes bot fleet.

The single source of truth is ~/.hermes/fleet_graph.yaml. This module owns
reading/validating it; the CLI wrapper and the dashboard API both import
this module, so all three surfaces can never drift.

Topology rules:
- one supervisor per bot (or none for the root)
- subordinates are the inverse mapping (derived, never stored twice)
- no cycles, no self-edges, every edge references a known profile
- lateral sends are rejected UNLESS a peer relation exists (see relations)
- escalation goes up, delegation goes down, peers coordinate sideways

Relations:
- `relations:` maps profile -> list of peers. Peer edges are symmetric
  (stored once, derived both ways at load), never supervisor/subordinate
  pairs, and always reference known profiles.
"""
from __future__ import annotations

import os
import tempfile
import time
import yaml
from pathlib import Path

FLEET_HOME = Path(os.environ.get(
    "FLEET_HOME", os.path.expanduser("~/.hermes")
)).expanduser()
GRAPH_PATH = Path(os.environ.get(
    "FLEET_GRAPH_PATH", str(FLEET_HOME / "fleet_graph.yaml")
)).expanduser()
DEFAULT_PROFILE = os.environ.get("FLEET_DEFAULT_PROFILE", "default").strip() or "default"

# Release installs never inherit a developer's private topology. Existing
# operator files remain authoritative; a fresh install begins empty and the UI
# lists discovered profiles as unassigned until the operator wires them.
DEFAULT_GRAPH: dict = {}
DEFAULT_RELATIONS: dict = {}


class GraphError(ValueError):
    pass


def _load_raw() -> dict:
    """Read the complete on-disk document under the GraphError contract."""
    if GRAPH_PATH.exists():
        try:
            with open(GRAPH_PATH) as f:
                data = yaml.safe_load(f) or {}
        except yaml.YAMLError as e:
            # corrupt file: raise inside the GraphError contract so every
            # consumer (API 500-with-detail, fleet_msg JSON refusal) degrades
            # cleanly instead of leaking a raw ParserError.
            raise GraphError(f"fleet_graph.yaml is not valid YAML: {e}") from e
    else:
        data = {}
    if not isinstance(data, dict):
        raise GraphError("fleet_graph.yaml must be a mapping of profile -> node")
    meta = data.get("_meta")
    if meta is not None and not isinstance(meta, dict):
        raise GraphError("fleet_graph.yaml _meta must be a mapping")
    return data


def load_metadata() -> dict:
    """Operator-owned non-topology settings stored under `_meta`."""
    return dict((_load_raw().get("_meta") or {}))


def load_profile_aliases() -> dict[str, str]:
    """Map graph-facing node names to canonical Hermes profile names."""
    raw = load_metadata().get("profile_aliases") or {}
    if not isinstance(raw, dict):
        raise GraphError("_meta.profile_aliases must be a mapping")
    aliases: dict[str, str] = {}
    for alias, profile in raw.items():
        alias, profile = str(alias).strip(), str(profile).strip()
        if not alias or not profile or alias == "_meta":
            raise GraphError("profile aliases require non-empty profile names")
        aliases[alias] = profile
    return aliases


def resolve_profile(name: str) -> str:
    """Resolve a graph node/alias to the real Hermes profile name."""
    return load_profile_aliases().get(name, name)


def graph_node_for_profile(profile: str, graph: dict | None = None) -> str | None:
    """Find the graph node representing one canonical Hermes profile."""
    graph = graph if graph is not None else load_graph()
    if profile in graph and resolve_profile(profile) == profile:
        return profile
    return next((name for name in graph if resolve_profile(name) == profile), None)


def load_graph() -> dict:
    data = _load_raw()
    # `_meta` is storage metadata, never a profile node.
    merged = {k: dict(v or {}) for k, v in data.items() if k != "_meta"}
    for name, node in data.items():
        if name == "_meta":  # storage metadata (relations), not a profile
            continue
        merged.setdefault(name, {})
        merged[name].update(node or {})
    return normalize(merged)


def _relations_from_raw(data: dict) -> dict:
    """Extract the relations map from a raw yaml doc. Layout: `_meta.relations`.
    Legacy fallback: per-node `peers:` lists (read-only migration path)."""
    meta = data.get("_meta") if isinstance(data, dict) else None
    if isinstance(meta, dict) and isinstance(meta.get("relations"), dict):
        return dict(meta["relations"])
    # legacy: collect per-node peers
    legacy = {}
    for name, node in (data or {}).items():
        if name == "_meta" or not isinstance(node, dict):
            continue
        if node.get("peers"):
            legacy[name] = list(node["peers"])
    return legacy


def load_relations() -> dict:
    """Symmetric peer map: profile -> sorted list of peers (derived both ways).

    Disk (`_meta.relations`) is authoritative when present — the UI saves the
    FULL map, so removals stick. Defaults apply only to a fresh file."""
    data = _load_raw()
    meta = data.get("_meta")
    rel_raw = _relations_from_raw(data)
    if isinstance(meta, dict) and meta.get("relations") is not None:
        # authoritative disk state — no default merging, removals are real
        merged = {k: list(v) for k, v in rel_raw.items()}
    elif GRAPH_PATH.exists():
        # operator file exists but has no _meta.relations: their choice — no peers
        merged = {k: list(v) for k, v in rel_raw.items()}
    else:
        merged = {}
    graph = load_graph()
    return normalize_relations(merged, graph)


def normalize_relations(rel: dict, graph: dict) -> dict:
    """Validate + symmetrize a relations map against a normalized graph."""
    if not isinstance(rel, dict):
        raise GraphError("relations must be a mapping of profile -> [peers]")
    known = set(graph)
    out: dict[str, set] = {}

    for name, peers in rel.items():
        name = str(name)
        if name not in known:
            raise GraphError(f"relations: '{name}' is not a known profile")
        for p in (peers or []):
            p = str(p)
            if p not in known:
                raise GraphError(f"relations: {name} -> unknown peer '{p}'")
            if p == name:
                raise GraphError(f"relations: {name} cannot peer with itself")
            sup = graph.get(name, {}).get("supervisor")
            subs = graph.get(name, {}).get("subordinates", [])
            if p == sup:
                raise GraphError(f"relations: {name} -> {p} is its supervisor, not a peer")
            if p in subs:
                raise GraphError(f"relations: {name} -> {p} is its subordinate, not a peer")
            out.setdefault(name, set()).add(p)
            out.setdefault(p, set()).add(name)

    return {k: sorted(v) for k, v in sorted(out.items())}


def save_graph(graph: dict, relations: dict | None = None) -> dict:
    """Persist the graph. Storage layout: a top-level `_meta:` key holds
    `{relations: {...}}`; every other top-level key is a profile node.
    (A profile literally named '_meta' is not supported — acceptable.)"""
    normalized = normalize(graph)
    rel_normalized = normalize_relations(
        relations if relations is not None else load_relations(), normalized)
    metadata = load_metadata() if GRAPH_PATH.exists() else {}
    metadata["relations"] = rel_normalized
    doc = {"_meta": metadata}
    for name, node in normalized.items():
        doc[name] = dict(node)
    GRAPH_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Every save gets a unique sibling temp file. A fixed `.tmp` name is
    # atomic for readers but races with another concurrent save's os.replace().
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", dir=GRAPH_PATH.parent,
            prefix=f".{GRAPH_PATH.name}.", suffix=".tmp", delete=False,
        ) as f:
            tmp_path = Path(f.name)
            yaml.safe_dump(doc, f, sort_keys=True, default_flow_style=False)
            f.flush()
            os.fsync(f.fileno())
        # Windows: concurrent os.replace() to the same destination raises
        # PermissionError (WinError 5) because NTFS rename is exclusive on the
        # target file. Retry with exponential backoff so concurrent savers
        # serialize on the rename instead of crashing. No-op on POSIX where
        # this never triggers.
        for attempt, delay in enumerate((0.05, 0.1, 0.2, 0.4, 0.8)):
            try:
                os.replace(tmp_path, GRAPH_PATH)
                tmp_path = None
                break
            except (PermissionError, OSError):
                if attempt < 4:
                    time.sleep(delay)
                else:
                    raise
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
    return normalized


def normalize(graph: dict) -> dict:
    """Validate + complete a graph. Raises GraphError on any violation."""
    if not isinstance(graph, dict):
        raise GraphError("graph must be a mapping of profile -> node")
    g = {name: dict(node or {}) for name, node in graph.items()}
    known = set(g)

    # CAPTURE RAW SUPERVISORS BEFORE ANY MUTATION — cycle detection and
    # the supervisor/subordinate reference check must see the user's input
    # exactly as written, including contradictory edges that derivation
    # would silently rewrite away.
    raw_sup = {n: g[n].get("supervisor") for n in g}
    raw_subs = {n: list(g[n].get("subordinates") or []) for n in g}

    # every supervisor/subordinate reference must be a known node
    for name, node in g.items():
        sup = node.get("supervisor")
        if sup and sup not in known:
            raise GraphError(f"{name}: supervisor '{sup}' is not a known profile")
        for s in node.get("subordinates", []):
            if s not in known:
                raise GraphError(f"{name}: subordinate '{s}' is not a known profile")

    # exactly-one-supervisor: if a node is listed as subordinate by two bots, error
    owners: dict[str, list[str]] = {}
    for name, node in g.items():
        for s in node.get("subordinates", []):
            owners.setdefault(s, []).append(name)
    for sub, sups in owners.items():
        declared = g[sub].get("supervisor")
        real = [s for s in sups if s != declared] or sups
        if len(real) > 1:
            raise GraphError(f"{sub} has multiple supervisors: {real}")

    # derive subordinates from supervisors
    for name, node in list(g.items()):
        sup = node.get("supervisor")
        if sup:
            if sup == name:
                raise GraphError(f"{name}: cannot be its own supervisor")
            g.setdefault(sup, {}).setdefault("subordinates", [])
            subs = g[sup].setdefault("subordinates", [])
            if name not in subs:
                subs.append(name)

    # drop subordinates entries that contradict a node's own supervisor
    for name, node in g.items():
        sup = node.get("supervisor")
        subs = node.get("subordinates") or []
        g[name]["subordinates"] = [s for s in subs if s != sup and s != name]

    # self-edge check (after contradiction drop, since self-edge on a node
    # with no explicit supervisor survives until here)
    for name, node in g.items():
        if node.get("supervisor") == name:
            raise GraphError(f"{name}: cannot be its own supervisor")

    # cycle check — build the effective supervisor relation from the CLEANED
    # graph (after derivation + contradiction-drop). The explicit `supervisor:`
    # field is authoritative; for nodes with only a subordinate back-edge, the
    # back-edge implies the supervisor. This catches cycles declared entirely
    # via subordinates, mixed contradictory cycles, and self-edges, while
    # tolerating redundant listings (parent lists child that also declares it).
    eff_sup = {n: g[n].get("supervisor") for n in g}
    for name, node in g.items():
        for s in node.get("subordinates", []):
            if s in g and not eff_sup.get(s):
                eff_sup[s] = name
    for start in g:
        seen, cur = set(), start
        while True:
            cur = eff_sup.get(cur)
            if not cur:
                break
            if cur in seen or cur == start:
                raise GraphError(f"cycle detected through '{start}'")
            seen.add(cur)

    # MATERIALIZE implied supervisors — a subordinates-only declaration must
    # resolve to a real supervisor field, or can_communicate/chain/describe
    # would treat the tree's own edges as blocked lateral sends.
    for name, node in g.items():
        for s in node.get("subordinates", []):
            if s in g and not g[s].get("supervisor"):
                g[s]["supervisor"] = name

    return g


def can_communicate(graph: dict, sender: str, recipient: str,
                    relations: dict | None = None) -> tuple[bool, str]:
    """Policy: up (to supervisor), down (to own subordinates), or sideways
    (to a declared peer relation). Everything else is blocked."""
    if sender not in graph:
        return False, f"unknown sender '{sender}'"
    if recipient not in graph:
        return False, f"unknown recipient '{recipient}'"
    if sender == recipient:
        return False, "cannot message yourself"
    if graph[recipient].get("supervisor") == sender:
        return True, "down"
    if graph[sender].get("supervisor") == recipient:
        return True, "up"
    if relations and recipient in relations.get(sender, []):
        return True, "peer"
    return False, (f"lateral send blocked: '{sender}' and '{recipient}' are not "
                   f"supervisor/subordinate or declared peers — route "
                   f"through '{graph[sender].get('supervisor')}'")


def chain(graph: dict, sender: str, recipient: str) -> list[str] | None:
    """Routing chain sender -> ... -> recipient following supervisor links."""
    if sender not in graph or recipient not in graph:
        return None
    path, seen, cur = [sender], set(), sender
    while cur != recipient:
        if cur in seen:
            return None
        seen.add(cur)
        cur = graph[cur].get("supervisor")
        if not cur:
            return None
        path.append(cur)
    return path


def describe(graph: dict, relations: dict | None = None) -> dict:
    out = {}
    for name, node in sorted(graph.items()):
        entry = {"supervisor": node.get("supervisor"),
                 "subordinates": sorted(node.get("subordinates", []))}
        if relations:
            entry["peers"] = relations.get(name, [])
        out[name] = entry
    return out


# ── delegation feasibility (pure graph, additive) ─────────────────────

def subtree_nodes(graph: dict, node: str, max_depth: int = 5) -> list[str]:
    """BFS: all nodes in the subordinate tree of `node` within max_depth hops.

    Pure graph operation — no profile reads, no host coupling.
    Includes `node` itself at depth 0. Returns [] if node not in graph."""
    if node not in graph:
        return []
    visited: set[str] = set()
    result: list[str] = []
    frontier: list[tuple[str, int]] = [(node, 0)]
    while frontier:
        cur, depth = frontier.pop(0)
        if cur in visited or depth > max_depth:
            continue
        visited.add(cur)
        result.append(cur)
        for sub in graph.get(cur, {}).get("subordinates", []):
            if sub not in visited:
                frontier.append((sub, depth + 1))
    return result


def subtree_depth(graph: dict, node: str) -> int:
    """Maximum depth of the subordinate tree below `node`. Leaf = 0.
    Pure recursion over the graph — safe for typical fleet depths (<10)."""
    if node not in graph:
        return 0
    subs = graph.get(node, {}).get("subordinates", [])
    if not subs:
        return 0
    return 1 + max(subtree_depth(graph, s) for s in subs)


def can_delegate_to(graph: dict, sender: str, recipient: str,
                    contract: dict | None = None) -> tuple[bool, str]:
    """Structural check: can `recipient`'s subtree absorb a delegation?

    Purely graph-based — no profile reads, no host coupling.
    Checks:
      1. sender != recipient, both known
      2. recipient has subordinates (a leaf cannot delegate)
      3. if contract.max_depth set, subtree depth >= max_depth
      4. contract.max_depth clamped to >= 1

    Returns (ok, reason) consistent with can_communicate contract.
    Caller is responsible for the edge check (can_communicate) first."""
    if sender not in graph:
        return False, f"unknown sender '{sender}'"
    if recipient not in graph:
        return False, f"unknown recipient '{recipient}'"
    if sender == recipient:
        return False, "cannot delegate to yourself"

    # Recipient must have subordinates to split work to
    subs = graph.get(recipient, {}).get("subordinates", [])
    if not subs:
        return False, f"'{recipient}' has no subordinates to delegate to"

    # Contract depth constraint
    if contract and isinstance(contract, dict):
        max_depth = contract.get("max_depth")
        if max_depth is not None:
            try:
                max_depth = int(max_depth)
            except (TypeError, ValueError):
                return False, f"contract.max_depth must be an integer, got {max_depth!r}"
            if max_depth < 1:
                return False, "contract.max_depth must be >= 1"
            available = subtree_depth(graph, recipient)
            if available < max_depth:
                return False, (f"'{recipient}' subtree depth {available} "
                               f"< contract max_depth {max_depth}")
    return True, "delegation feasible"
