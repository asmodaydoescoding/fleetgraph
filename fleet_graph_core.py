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

import contextlib
import os
import tempfile
import threading
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


@contextlib.contextmanager
def write_lock(timeout: float = 10.0):
    """Serialize read-modify-write cycles across threads AND processes.

    In-process: a module-wide guard RLock held for the whole critical
    section (reentrant so save_graph can nest inside an API handler's
    wider lock). Cross-process: an advisory lock on a sibling `.lock`
    file — the dashboard, the CLI, and bots save through this module
    from separate processes, and without it concurrent read-modify-write
    cycles silently drop each other's updates (the final state would be
    whichever save completed last over a whole-file replace). One cached
    fd + depth counter keeps nesting
    safe: flock/locking treat two fds of the same file independently,
    which would self-deadlock."""
    lock_path = GRAPH_PATH.with_name(GRAPH_PATH.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    busy = GraphError("fleet graph is busy: another save is in progress")
    with _thread_guard:
        st = _flock_state
        if st["fd"] is None:
            f = open(lock_path, "a+")
            deadline = time.monotonic() + timeout
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt
                        f.seek(0)
                        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        f.close()
                        raise busy
                    time.sleep(0.02)
            st["fd"] = f
            st["depth"] = 1
        else:
            st["depth"] += 1
        try:
            yield
        finally:
            st["depth"] -= 1
            if st["depth"] <= 0:
                f, st["fd"], st["depth"] = st["fd"], None, 0
                try:
                    if os.name == "nt":
                        import msvcrt
                        f.seek(0)
                        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(f, fcntl.LOCK_UN)
                except OSError:
                    pass
                finally:
                    f.close()


_thread_guard = threading.RLock()
_flock_state: dict = {"fd": None, "depth": 0}


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
        if (not alias or not profile or alias == "_meta" or
                alias != os.path.basename(alias) or
                profile != os.path.basename(profile) or
                alias in (".", "..") or profile in (".", "..") or
                len(alias.encode("utf-8", "surrogatepass")) > 255 or
                len(profile.encode("utf-8", "surrogatepass")) > 255):
            raise GraphError("profile aliases require plain, bounded profile names")
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
    rel_raw = _relations_from_raw(data)
    if data.get("_meta", {}).get("relations") is not None:
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


def save_graph(graph: dict, relations: dict | None = None,
               extra_metadata: dict | None = None) -> dict:
    """Persist the graph. Storage layout: a top-level `_meta:` key holds
    `{relations: {...}}`; every other top-level key is a profile node.
    (A profile literally named '_meta' is not supported — acceptable.)"""
    normalized = normalize(graph)
    rel_normalized = normalize_relations(
        relations if relations is not None else load_relations(), normalized)
    metadata = load_metadata() if GRAPH_PATH.exists() else {}
    if extra_metadata:
        metadata.update(extra_metadata)
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


# ── profile discovery + import (issue #4) ─────────────────────────────
# Hermes keeps one directory per agent profile under FLEET_HOME/profiles/.
# The graph YAML is the sole source of truth for topology; discovery only
# REPORTS what exists on disk and import wires chosen profiles in through
# the same normalize/save path as every other write. Explicit action, never
# a startup auto-scan.

PROFILES_SUBDIR = "profiles"


def _profiles_root() -> Path:
    return FLEET_HOME / PROFILES_SUBDIR


def discover_missing_profiles() -> list[dict]:
    """On-disk profile directories not yet represented as graph nodes.

    Tolerant of odd directory shapes: non-directories are ignored, a
    missing SOUL.md yields empty metadata instead of an error. Returns
    [{name, title, description}] sorted by name.
    """
    root = _profiles_root()
    if not root.is_dir():
        return []
    try:
        graph = load_graph()
    except GraphError:
        graph = {}
    known = set(graph)

    discovered = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        name = entry.name
        # '_meta' is reserved by the YAML document layout (normalize drops
        # it silently), so offering it for import would report success
        # while the node never appears. Exclude at discovery.
        if name in known or name.startswith(".") or name == "_meta":
            continue
        title = ""
        description = ""
        soul_path = entry / "SOUL.md"
        if soul_path.is_file():
            try:
                with open(soul_path, encoding="utf-8") as f:
                    for line in f:
                        s = line.strip()
                        if not title and s.startswith("# "):
                            title = s[2:].strip()
                        low = s.lower()
                        if not description and (
                            low.startswith("you are")
                            or low.startswith("**mission:**")
                            or low.startswith("mission:")
                        ):
                            description = (
                                s.split(". ")[0].rstrip(".")
                                .replace("**", "").strip()
                            )
                        if title and description:
                            break
            except (OSError, UnicodeDecodeError):
                pass  # unreadable persona: still importable, just unnamed
        discovered.append({
            "name": name,
            "title": title,
            "description": description,
        })
    return discovered


def import_existing_profiles(
    names: list[str], supervisor: str | None = None,
) -> dict:
    """Wire existing on-disk profiles into the graph.

    Collision policy: a requested name already in the graph is skipped
    (reported, never overwritten). Names that do not exist on disk are
    reported as unknown. Returns
    {imported: [names], skipped: [{name, reason}], unknown: [names]}.
    """
    root = _profiles_root()
    on_disk: set[str] = set()
    if root.is_dir():
        for entry in root.iterdir():
            # '_meta' excluded for the same reason as in discovery: the
            # reserved name would vanish at normalize() after a claimed
            # success. Defense in depth if import is called directly.
            if (
                entry.is_dir()
                and not entry.name.startswith(".")
                and entry.name != "_meta"
            ):
                on_disk.add(entry.name)

    try:
        graph = load_graph()
    except GraphError as e:
        raise GraphError(f"fleet graph unusable: {e}") from e

    imported: list[str] = []
    skipped: list[dict] = []
    unknown: list[str] = []

    if supervisor and supervisor not in graph:
        raise GraphError(
            f"supervisor '{supervisor}' is not a known graph node")

    for name in dict.fromkeys(names):
        if name in graph:
            skipped.append({"name": name, "reason": "already in graph"})
        elif name not in on_disk:
            unknown.append(name)
        else:
            graph[name] = {"supervisor": supervisor or None, "subordinates": []}
            imported.append(name)

    if imported:
        save_graph(graph)
    return {"imported": imported, "skipped": skipped, "unknown": unknown}
