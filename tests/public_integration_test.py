#!/usr/bin/env python3
"""Hermetic end-to-end integration suite for the shipped Fleetgraph core.

Everything runs inside a throwaway temporary installation: the documented
environment overrides redirect every storage location into a temp directory
BEFORE the core module is imported (it snapshots configuration at import
time), a small generically-named fleet topology is built and saved through
the public save API, then read back from disk and compared field-for-field.

Pure standard library plus repository code. No network access, no live
services, no machine-specific paths, no operator data.

Run from anywhere:

    python3 tests/public_integration_test.py

The last line of output is always
`INTEGRATION SUMMARY: N passed, M failed` and the exit status is nonzero
when any check failed.
"""
from __future__ import annotations

import os
import sys
import tempfile
import traceback
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"[PASS] {name}")
    else:
        failed += 1
        print(f"[FAIL] {name}" + (f" — {detail}" if detail else ""))


# Canonical shape of the small generic fleet used below: one coordinator,
# two direct reports, one second-level member, plus sibling peer edges.
EXPECTED_STRUCTURE = {
    "node-a": {"supervisor": None, "subordinates": ["node-b", "node-c"]},
    "node-b": {"supervisor": "node-a", "subordinates": ["node-d"]},
    "node-c": {"supervisor": "node-a", "subordinates": []},
    "node-d": {"supervisor": "node-b", "subordinates": []},
}

# Symmetrized form of the peer edges handed to the save API.
EXPECTED_RELATIONS = {
    "node-b": ["node-c"],
    "node-c": ["node-b", "node-d"],
    "node-d": ["node-c"],
}


def build_fleet() -> dict:
    """A small, generically named fleet used only by this test."""
    return {
        "node-a": {"title": "Coordinator"},
        "node-b": {"supervisor": "node-a", "title": "Worker A"},
        "node-c": {"supervisor": "node-a"},
        "node-d": {"supervisor": "node-b"},
    }


def main() -> int:
    global failed
    saved_env = {
        key: os.environ.get(key)
        for key in (
            "FLEET_HOME",
            "FLEET_GRAPH_PATH",
            "FLEET_DEFAULT_PROFILE",
            "FLEET_INBOX_DIR",
            "FLEET_PROFILES_DIR",
        )
    }
    try:
        with tempfile.TemporaryDirectory(prefix="fleet-integration-") as td:
            home = Path(td) / "installation-home"
            home.mkdir()
            graph_path = home / "fleet_graph.yaml"
            inbox_dir = home / "message-inbox"
            profiles_dir = home / "profiles"
            inbox_dir.mkdir()
            profiles_dir.mkdir()

            # Redirect every runtime location before importing the core
            # module — it reads these variables at import time.
            os.environ["FLEET_HOME"] = str(home)
            os.environ["FLEET_GRAPH_PATH"] = str(graph_path)
            os.environ["FLEET_DEFAULT_PROFILE"] = "primary-profile"
            os.environ["FLEET_INBOX_DIR"] = str(inbox_dir)
            os.environ["FLEET_PROFILES_DIR"] = str(profiles_dir)

            import yaml  # repository runtime dependency of fleet_graph_core

            import fleet_graph_core as core

            # --- configuration reaches the module ------------------------
            check("storage home honors the environment override",
                  core.FLEET_HOME == home, repr(core.FLEET_HOME))
            check("topology path honors the environment override",
                  core.GRAPH_PATH == graph_path, repr(core.GRAPH_PATH))
            check("protected default profile is configurable",
                  core.DEFAULT_PROFILE == "primary-profile",
                  repr(core.DEFAULT_PROFILE))

            # --- fresh-install defaults ----------------------------------
            fresh_error = ""
            try:
                fresh_graph = core.load_graph()
                fresh_relations = core.load_relations()
                fresh_metadata = core.load_metadata()
            except Exception as exc:
                fresh_graph, fresh_relations, fresh_metadata = None, None, None
                fresh_error = repr(exc)
            check("fresh install loads cleanly", not fresh_error, fresh_error)
            check("fresh install starts with an empty graph", fresh_graph == {},
                  repr(fresh_graph))
            check("fresh install starts with no peer relations",
                  fresh_relations == {}, repr(fresh_relations))
            check("fresh install carries no operator metadata",
                  fresh_metadata == {}, repr(fresh_metadata))
            check("fresh install writes nothing to disk", not graph_path.exists())

            # Operator metadata is seeded through the documented storage
            # layout (_meta key beside the topology nodes).
            graph_path.write_text(yaml.safe_dump({
                "_meta": {
                    "relations": {},
                    "profile_aliases": {"front-node": "node-a"},
                    "root_owner_label": "Operator",
                },
            }, sort_keys=True))

            # --- save through the public API ------------------------------
            relations_input = {
                "node-b": ["node-c"],
                "node-d": ["node-c"],
            }
            saved = core.save_graph(build_fleet(), relations=relations_input)
            check("save API returns the normalized structure",
                  core.describe(saved) == EXPECTED_STRUCTURE,
                  repr(core.describe(saved)))
            check("save derives subordinates from supervisors",
                  sorted(saved["node-a"]["subordinates"])
                  == ["node-b", "node-c"])

            # --- reload everything back from disk -------------------------
            reloaded = core.load_graph()
            check("nodes and hierarchy survive the disk roundtrip",
                  core.describe(reloaded) == EXPECTED_STRUCTURE,
                  repr(core.describe(reloaded)))
            check("roundtrip preserves node attributes",
                  reloaded.get("node-a", {}).get("title") == "Coordinator",
                  repr(reloaded.get("node-a")))
            check("graph roundtrips exactly as saved", reloaded == saved)

            reloaded_relations = core.load_relations()
            check("peer relations survive the roundtrip and stay symmetric",
                  reloaded_relations == EXPECTED_RELATIONS,
                  repr(reloaded_relations))

            metadata = core.load_metadata()
            check("operator label metadata survives the roundtrip",
                  metadata.get("root_owner_label") == "Operator",
                  repr(metadata))
            check("alias metadata survives the roundtrip",
                  metadata.get("profile_aliases") == {"front-node": "node-a"},
                  repr(metadata.get("profile_aliases")))
            check("relations persist under storage metadata",
                  metadata.get("relations") == EXPECTED_RELATIONS,
                  repr(metadata.get("relations")))
            check("aliases resolve through the public helper",
                  core.resolve_profile("front-node") == "node-a")

            raw_doc = yaml.safe_load(graph_path.read_text()) or {}
            check("storage layout keeps metadata beside the topology nodes",
                  isinstance(raw_doc, dict) and "_meta" in raw_doc
                  and "node-a" in raw_doc)

            # --- an identical second save must be stable -------------------
            core.save_graph(reloaded, relations=reloaded_relations)
            check("second identical save is stable on disk",
                  core.load_graph() == reloaded
                  and core.load_relations() == EXPECTED_RELATIONS)

            # --- policy helpers agree with the persisted graph --------------
            up_ok, up_how = core.can_communicate(
                reloaded, "node-c", "node-a")
            down_ok, down_how = core.can_communicate(
                reloaded, "node-b", "node-d")
            peer_ok, peer_how = core.can_communicate(
                reloaded, "node-b", "node-c", reloaded_relations)
            far_ok, _far_how = core.can_communicate(
                reloaded, "node-a", "node-d")
            check("escalation routes to the immediate supervisor",
                  up_ok and up_how == "up")
            check("delegation routes to the direct subordinate",
                  down_ok and down_how == "down")
            check("declared peers coordinate sideways",
                  peer_ok and peer_how == "peer")
            check("non-adjacent chain members stay blocked", not far_ok)
            check("routing chain follows supervisors",
                  core.chain(reloaded, "node-d", "node-a")
                  == ["node-d", "node-b", "node-a"])

            # --- atomic-write hygiene ---------------------------------------
            leftovers = sorted(p.name for p in home.glob(".fleet_graph.yaml.*"))
            check("atomic saves leave no temp files behind", not leftovers,
                  repr(leftovers))
    except Exception:
        failed += 1
        print("[FAIL] unexpected exception during the integration run")
        traceback.print_exc()
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    print(f"\nINTEGRATION SUMMARY: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
