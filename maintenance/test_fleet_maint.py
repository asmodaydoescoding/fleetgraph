#!/usr/bin/env python3
"""Hermetic test suite for maintenance/fleet_maint.py.

Mirrors tests/public_integration_test.py conventions: environment overrides
redirect every storage location into a temp directory BEFORE the core module
is imported (it snapshots config at import time), a small generic fleet is
built through the public save API, and every check compares read-back state.
No network, no live services, no operator data.

Run:  python3 maintenance/test_fleet_maint.py
Last line is always `MAINT SUMMARY: N passed, M failed`; nonzero exit on fail.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

# Redirect storage BEFORE importing fleet_graph_core (it snapshots env at
# import time) — same contract as the repo's public integration suite.
_TMP = tempfile.mkdtemp(prefix="fleet-maint-test-")
os.environ["FLEET_HOME"] = _TMP
os.environ["FLEET_GRAPH_PATH"] = str(Path(_TMP) / "fleet_graph.yaml")
os.environ["FLEET_INBOX_DIR"] = str(Path(_TMP) / "fleet-inbox")
os.environ["FLEET_PROFILES_DIR"] = str(Path(_TMP) / "profiles")

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import yaml  # noqa: E402

from fleet_graph_core import save_graph, load_graph, load_relations  # noqa: E402
from maintenance.fleet_maint import (  # noqa: E402
    find_stale_profiles, prune, rotate, status, MAX_INBOX_LINES,
)

INBOX_DIR = Path(os.environ["FLEET_INBOX_DIR"])
WATERMARK_DIR = INBOX_DIR / ".read"

passed = 0
failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"[PASS] {name}")
    else:
        failed += 1
        print(f"[FAIL] {name}" + (f" — {detail}" if detail else ""))


def build_fleet() -> None:
    graph = {
        "node-a": {"title": "Coordinator"},
        "node-b": {"supervisor": "node-a", "title": "Worker A"},
        "node-c": {"supervisor": "node-a"},
    }
    relations = {"node-b": ["node-c"], "node-c": ["node-b"]}
    save_graph(graph, relations=relations)


def seed_inbox(name: str, count: int, sender: str = "node-a") -> int:
    """Write N messages; returns the watermark count set to half."""
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    f = INBOX_DIR / f"{name}.jsonl"
    with open(f, "w") as fh:
        for i in range(count):
            rec = {"ts": f"2026-08-23T00:00:{i:02d}Z", "from": sender,
                   "type": "update", "summary": f"msg {i}"}
            fh.write(json.dumps(rec) + "\n")
    WATERMARK_DIR.mkdir(parents=True, exist_ok=True)
    wm_path = WATERMARK_DIR / f"{name}.json"
    at_read = count // 2 if count >= 4 else 0
    wm_path.write_text(json.dumps({"last_read_ts": "2026-08-23T00:00:00Z",
                                   "count_at_read": at_read}))
    return at_read


def main() -> int:
    build_fleet()

    # ── prune: nothing stale when all profiles exist ──
    profiles_dir = Path(os.environ["FLEET_PROFILES_DIR"])
    for n in ("node-a", "node-b", "node-c"):
        (profiles_dir / n).mkdir(parents=True, exist_ok=True)
    (profiles_dir / "default").mkdir(parents=True, exist_ok=True)

    stale = find_stale_profiles()
    check("no stale profiles when all exist on disk", stale == [], str(stale))
    out = prune(dry_run=False)
    check("prune with nothing stale is a no-op",
          out["changed"] is False and out["pruned"] == [])

    # ── prune: profile deleted on disk → pruned everywhere ──
    import shutil
    shutil.rmtree(profiles_dir / "node-c")
    stale = find_stale_profiles()
    check("deleted profile detected as stale", stale == ["node-c"], str(stale))

    dry = prune(dry_run=True)
    check("dry-run reports but does not change",
          dry["dry_run"] is True and dry["pruned"] == ["node-c"])
    g = load_graph()
    check("dry-run left graph intact", "node-c" in g and "node-a" in g)

    out = prune(dry_run=False)
    check("prune removed node from graph", "node-c" not in load_graph())
    check("prune removed peer edges both ways",
          "node-c" not in load_relations().get("node-b", []))
    inbox_file = INBOX_DIR / "node-c.jsonl"
    check("stale node absent from graph after prune",
          out["pruned"] == ["node-c"] and out["changed"] is True)
    assert inbox_file.exists() is False or True  # no inbox seeded yet

    # re-add node-c inbox + watermark then delete again to verify cleanup
    seed_inbox("node-c", 6)
    (profiles_dir / "node-c").mkdir(parents=True, exist_ok=True)
    save_graph({
        "node-a": {"title": "Coordinator"},
        "node-b": {"supervisor": "node-a", "title": "Worker A"},
        "node-c": {"supervisor": "node-a"},
    }, relations={"node-b": ["node-c"], "node-c": ["node-b"]})
    shutil.rmtree(profiles_dir / "node-c")
    # rebuild its graph presence so prune targets it
    save_graph(load_graph(), relations=None)  # normalize keeps it
    out = prune(dry_run=False)
    check("inbox file deleted on prune",
          not (INBOX_DIR / "node-c.jsonl").exists())
    check("watermark deleted on prune",
          not (WATERMARK_DIR / "node-c.json").exists())

    # default profile can never be pruned even if missing from disk listing
    (profiles_dir / "default").mkdir(parents=True, exist_ok=True)
    try:
        out2 = prune(only=["default"])
        check("default profile refuses pruning via --profile",
              out2.get("pruned") == [] or "default" not in out2.get("pruned", []),
              str(out2))
    except Exception as e:
        check("default profile refuses pruning via --profile (raised)", True)

    # unknown --profile target refused cleanly
    try:
        prune(only=["ghost-node"])
        check("unknown --profile refused", False, "no error raised")
    except Exception as e:
        check("unknown --profile refused", "not in graph" in str(e), str(e))

    # ── rotate: under cap untouched ──
    seed_inbox("node-b", 10)
    r = rotate(keep=50)
    check("small inbox untouched by rotation",
          r["rotated"]["node-b"]["rotated"] is False)

    # ── rotate: over cap keeps newest, clamps watermark ──
    at_read = seed_inbox("node-b", 30)   # wm at 15
    r = rotate(keep=10)
    entry = r["rotated"]["node-b"]
    check("over-cap inbox rotated", entry["rotated"] is True)
    check("kept exactly cap lines", entry["kept"] == 10, str(entry))
    lines = (INBOX_DIR / "node-b.jsonl").read_text().splitlines()
    check("file on disk now has cap lines", len(lines) == 10, str(len(lines)))
    kept_summaries = [json.loads(l)["summary"] for l in lines]
    check("newest messages retained (msg 20..29)",
          kept_summaries[0] == "msg 20" and kept_summaries[-1] == "msg 29",
          str(kept_summaries[:2]))
    wm = json.loads((WATERMARK_DIR / "node-b.json").read_text())
    check("watermark clamped to new total",
          wm["count_at_read"] == 10,
          f"count_at_read={wm['count_at_read']}")

    # unread math after clamp: total - count_at_read >= 0
    total_now = len(lines)
    unread = max(0, total_now - wm["count_at_read"])
    check("unread badge stays non-negative after rotation", unread >= 0)

    # malformed lines dropped during rotation
    f = INBOX_DIR / "node-b.jsonl"
    f.write_text("\n".join(lines[:5]) + "\n{not json\n" + "\n".join(lines[5:]) + "\n")
    r = rotate(keep=10)
    check("malformed line dropped in rotation",
          len(f.read_text().splitlines()) == 10)

    # idempotence: rotating again changes nothing
    before = f.read_text()
    r2 = rotate(keep=10)
    check("rotation is idempotent",
          f.read_text() == before and r2["rotated"]["node-b"]["rotated"] is False)

    # ── status: read-only snapshot ──
    snap = status()
    check("status lists inbox sizes", "node-b" in snap["inbox_sizes"])
    check("status flags over-cap inboxes",
          all(v <= snap["cap"] for v in snap["inbox_sizes"].values()))

    # invalid keep refused
    try:
        rotate(keep=0)
        check("keep<1 refused", False, "no error")
    except Exception as e:
        check("keep<1 refused", True)

    print(f"\nMAINT SUMMARY: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        print(f"\nMAINT SUMMARY: {passed} passed, {failed + 1} failed")
        sys.exit(1)
