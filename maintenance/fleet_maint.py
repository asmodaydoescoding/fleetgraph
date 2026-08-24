#!/usr/bin/env python3
"""fleet-maint — maintenance operations for the Fleet Graph plugin.

Closes two documented known limitations of fleet-graph v0.6.1:

1. Profile deletion does not prune `fleet_graph.yaml`, inboxes, or read
   watermarks — stale entries accumulate forever. `prune` removes every
   trace of a deleted profile in one atomic topology write.

2. Inbox JSONL files grow unboundedly. `rotate` caps each inbox at
   MAX_INBOX_LINES, keeping the newest messages and preserving the
   watermark contract (count_at_read is clamped so unread badges stay
   correct after rotation).

Both commands are idempotent: running them twice changes nothing the
second time. All writes go through fleet_graph_core.save_graph, so the
topology SSOT, validation, and atomic-rename guarantees are inherited,
never reimplemented here.

Usage:
  fleet-maint prune [--dry-run] [--profile NAME]...
  fleet-maint rotate [--dry-run] [--keep N]
  fleet-maint status

Exit codes: 0 ok, 2 refused (validation / GraphError).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
from fleet_graph_core import (  # noqa: E402
    DEFAULT_PROFILE, FLEET_HOME, GraphError, load_graph, load_metadata,
    load_relations, save_graph,
)

INBOX_DIR = Path(os.environ.get(
    "FLEET_INBOX_DIR", str(FLEET_HOME / "fleet-inbox"))).expanduser()
WATERMARK_DIR = INBOX_DIR / ".read"

# Default cap per inbox file. The live drawer reads ~30 messages per poll;
# 500 keeps weeks of context while bounding file growth.
MAX_INBOX_LINES = int(os.environ.get("FLEET_INBOX_MAX", "500"))


def _known_profile_dirs() -> set[str]:
    """Profiles that actually exist on disk (canonical Hermes profiles)."""
    from fleet_graph_core import GRAPH_PATH  # re-import for testability
    profiles_dir = Path(os.environ.get(
        "FLEET_PROFILES_DIR", str(FLEET_HOME / "profiles"))).expanduser()
    names = set()
    if profiles_dir.is_dir():
        for p in profiles_dir.iterdir():
            if p.is_dir() and p.name != "." and p.name != "..":
                names.add(p.name)
    names.add(DEFAULT_PROFILE)
    return names


def find_stale_profiles() -> list[str]:
    """Graph nodes whose canonical profile no longer exists on disk."""
    graph = load_graph()
    known = _known_profile_dirs()
    # A node is stale when neither its node name nor its resolved alias
    # maps to an existing profile directory.
    from fleet_graph_core import resolve_profile
    stale = []
    for name in graph:
        canonical = resolve_profile(name)
        if canonical not in known and name not in known:
            stale.append(name)
    return sorted(stale)


def prune(dry_run: bool = False, only: list[str] | None = None) -> dict:
    """Remove deleted profiles from topology, relations, inboxes,
    watermarks, and operator metadata aliases. One atomic PUT-equivalent.
    Refuses to touch DEFAULT_PROFILE — it always exists."""
    graph = load_graph()
    relations = load_relations()
    metadata = load_metadata()

    targets = set(only) if only else set(find_stale_profiles())
    if only:
        unknown = [n for n in only if n not in graph]
        if unknown:
            raise GraphError(f"not in graph: {', '.join(sorted(unknown))}")
    targets.discard(DEFAULT_PROFILE)

    if not targets:
        return {"pruned": [], "graph_nodes": len(graph), "changed": False}

    new_graph = {n: dict(node) for n, node in graph.items() if n not in targets}
    # strip pruned nodes from every remaining subordinates list — normalize()
    # refuses references to unknown profiles, so a parent still naming a
    # deleted child would make the whole prune refuse.
    for name, node in new_graph.items():
        if node.get("subordinates"):
            node["subordinates"] = [
                s for s in node["subordinates"] if s not in targets]
    # normalize() derives subordinates; dropped nodes vanish from parent lists.
    new_relations = {
        n: [p for p in peers if p not in targets]
        for n, peers in relations.items() if n not in targets
    }
    new_meta = dict(metadata)
    aliases = new_meta.get("profile_aliases") or {}
    if isinstance(aliases, dict):
        new_meta["profile_aliases"] = {
            a: p for a, p in aliases.items()
            if a not in targets and p not in targets
        }

    changed_files: list[str] = []
    if not dry_run:
        save_graph(new_graph, relations=new_relations)
        changed_files.append("fleet_graph.yaml")
        # rewrite _meta (aliases) without disturbing relations already saved
        data_path = Path(os.environ.get(
            "FLEET_GRAPH_PATH",
            str(Path(os.environ.get("FLEET_HOME", str(FLEET_HOME)))
                / "fleet_graph.yaml"))).expanduser()
        import yaml
        with open(data_path) as f:
            doc = yaml.safe_load(f) or {}
        meta = doc.get("_meta") or {}
        meta["profile_aliases"] = new_meta.get("profile_aliases") or {}
        doc["_meta"] = meta
        tmp = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", dir=data_path.parent, prefix=f".{data_path.name}.",
                suffix=".tmp", delete=False,
            ) as f:
                tmp = f.name
                import yaml as _y
                _y.safe_dump(doc, f, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, data_path)
            tmp = None
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

        for name in targets:
            inbox = INBOX_DIR / f"{name}.jsonl"
            if inbox.exists():
                inbox.unlink()
                changed_files.append(inbox.name)
            wm = WATERMARK_DIR / f"{name}.json"
            if wm.exists():
                wm.unlink()
                changed_files.append(wm.name)

    return {
        "pruned": sorted(targets),
        "graph_nodes": len(new_graph),
        "changed": True,
        "dry_run": dry_run,
        "files_touched": changed_files,
    }


def _parse_inbox_lines(path: Path) -> list[str]:
    """Raw valid JSONL lines (malformed lines are dropped on rotation)."""
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            json.loads(line)
            out.append(line)
        except Exception:
            continue
    return out


def rotate(dry_run: bool = False, keep: int = MAX_INBOX_LINES) -> dict:
    """Cap every inbox at `keep` newest lines. Watermarks clamp so unread
    counts survive rotation (count_at_read can never exceed total)."""
    if keep < 1:
        raise GraphError("--keep must be >= 1")
    results = {}
    if not INBOX_DIR.is_dir():
        return {"rotated": {}, "changed": False}
    for f in sorted(INBOX_DIR.glob("*.jsonl")):
        raw_lines = [l.strip() for l in f.read_text().splitlines() if l.strip()]
        valid = []
        malformed = 0
        for l in raw_lines:
            try:
                json.loads(l)
                valid.append(l)
            except Exception:
                malformed += 1
        # rotate when over cap OR when malformed lines need purging
        if len(valid) <= keep and malformed == 0:
            results[f.stem] = {"total": len(valid), "kept": len(valid),
                               "rotated": False}
            continue
        kept = valid[-keep:]
        dropped = len(raw_lines) - len(kept)
        wm_path = WATERMARK_DIR / f"{f.stem}.json"
        wm_note = None
        if wm_path.exists():
            try:
                wm = json.loads(wm_path.read_text())
                at_read = int(wm.get("count_at_read") or 0)
                if at_read > len(kept):
                    wm["count_at_read"] = len(kept)
                    if not dry_run:
                        wm_path.write_text(json.dumps(wm))
                    wm_note = f"clamped count_at_read -> {len(kept)}"
            except Exception:
                wm_note = "watermark unreadable; left untouched"
        if not dry_run:
            tmp = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w", dir=INBOX_DIR, prefix=f".{f.name}.",
                    suffix=".tmp", delete=False,
                ) as tf:
                    tmp = tf.name
                    tf.write("\n".join(kept) + "\n")
                    tf.flush()
                    os.fsync(tf.fileno())
                os.replace(tmp, f)
                tmp = None
            finally:
                if tmp:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
        results[f.stem] = {
            "total": len(valid), "kept": len(kept), "dropped": dropped,
            "rotated": True, **({"watermark": wm_note} if wm_note else {}),
        }
    changed = any(r.get("rotated") for r in results.values())
    return {"rotated": results, "changed": changed, "dry_run": dry_run}


def status() -> dict:
    """Read-only health snapshot: stale profiles + inbox sizes."""
    stale = find_stale_profiles()
    sizes = {}
    if INBOX_DIR.is_dir():
        for f in sorted(INBOX_DIR.glob("*.jsonl")):
            sizes[f.stem] = sum(
                1 for l in f.read_text().splitlines() if l.strip())
    over = {k: v for k, v in sizes.items() if v > MAX_INBOX_LINES}
    return {
        "stale_profiles": stale,
        "inbox_sizes": sizes,
        "over_cap": over,
        "cap": MAX_INBOX_LINES,
    }


def main() -> None:
    p = argparse.ArgumentParser(prog="fleet-maint")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("prune", help="remove deleted profiles everywhere")
    sp.add_argument("--dry-run", action="store_true")
    sp.add_argument("--profile", action="append", default=[],
                    help="prune this specific node (repeatable)")

    sr = sub.add_parser("rotate", help="cap inbox files at FLEET_INBOX_MAX")
    sr.add_argument("--dry-run", action="store_true")
    sr.add_argument("--keep", type=int, default=MAX_INBOX_LINES)

    st = sub.add_parser("status", help="read-only maintenance snapshot")

    args = p.parse_args()
    try:
        if args.cmd == "prune":
            out = prune(dry_run=args.dry_run, only=args.profile or None)
        elif args.cmd == "rotate":
            out = rotate(dry_run=args.dry_run, keep=args.keep)
        else:
            out = status()
        print(json.dumps(out, indent=1))
    except GraphError as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(2)


if __name__ == "__main__":
    main()
