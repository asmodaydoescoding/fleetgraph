#!/usr/bin/env python3
"""Delegation feasibility tests — additive, plugin-owned, zero protocol break."""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
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


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


with tempfile.TemporaryDirectory(prefix="fleet-delegate-") as td:
    home = Path(td) / "fleet-delegate-home"
    home.mkdir()
    graph_path = home / "fleet_graph.yaml"
    os.environ["FLEET_HOME"] = str(home)
    os.environ["FLEET_GRAPH_PATH"] = str(graph_path)

    core = load_module("fleet_graph_core_delegate_test", PLUGIN_DIR / "fleet_graph_core.py")

    # ── Test graph ─────────────────────────────────────────────────────
    #       baal
    #      /    \
    #   hermes   nyx
    #   /    \
    # data   spock
    #         |
    #        worf
    graph = {
        "baal": {"subordinates": ["hermes", "nyx"]},
        "hermes": {"supervisor": "baal", "subordinates": ["data", "spock"]},
        "nyx": {"supervisor": "baal"},
        "data": {"supervisor": "hermes"},
        "spock": {"supervisor": "hermes", "subordinates": ["worf"]},
        "worf": {"supervisor": "spock"},
    }
    relations = {}

    # ── subtree_depth ──────────────────────────────────────────────────
    check("subtree_depth: leaf node = 0",
          core.subtree_depth(graph, "worf") == 0)
    check("subtree_depth: spock has depth 1 (worf)",
          core.subtree_depth(graph, "spock") == 1)
    check("subtree_depth: hermes has depth 2 (spock→worf)",
          core.subtree_depth(graph, "hermes") == 2)
    check("subtree_depth: baal has depth 3 (hermes→spock→worf)",
          core.subtree_depth(graph, "baal") == 3)
    check("subtree_depth: unknown node = 0",
          core.subtree_depth(graph, "unknown") == 0)

    # ── subtree_nodes ──────────────────────────────────────────────────
    check("subtree_nodes: worf = [worf]",
          core.subtree_nodes(graph, "worf") == ["worf"])
    check("subtree_nodes: spock = [spock, worf]",
          set(core.subtree_nodes(graph, "spock")) == {"spock", "worf"})
    check("subtree_nodes: hermes = [hermes, data, spock, worf]",
          set(core.subtree_nodes(graph, "hermes")) == {"hermes", "data", "spock", "worf"})
    check("subtree_nodes: max_depth=1 on hermes = [hermes, data, spock]",
          set(core.subtree_nodes(graph, "hermes", max_depth=1)) == {"hermes", "data", "spock"})
    check("subtree_nodes: unknown node = []",
          core.subtree_nodes(graph, "unknown") == [])

    # ── can_delegate_to: basic feasibility ─────────────────────────────
    ok, why = core.can_delegate_to(graph, "baal", "hermes")
    check("can_delegate_to: baal→hermes (has subs)", ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "nyx")
    check("can_delegate_to: baal→nyx (leaf, no subs)", not ok, why)

    ok, why = core.can_delegate_to(graph, "hermes", "hermes")
    check("can_delegate_to: hermes→hermes (self)", not ok, why)

    ok, why = core.can_delegate_to(graph, "unknown", "hermes")
    check("can_delegate_to: unknown sender", not ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "unknown")
    check("can_delegate_to: unknown recipient", not ok, why)

    # ── can_delegate_to: contract depth ────────────────────────────────
    ok, why = core.can_delegate_to(graph, "baal", "hermes", {"max_depth": 2})
    check("can_delegate_to: hermes depth 2 >= contract 2", ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "hermes", {"max_depth": 3})
    check("can_delegate_to: hermes depth 2 < contract 3", not ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "spock", {"max_depth": 1})
    check("can_delegate_to: spock depth 1 >= contract 1", ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "spock", {"max_depth": 0})
    check("can_delegate_to: max_depth 0 rejected", not ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "hermes", {"max_depth": "abc"})
    check("can_delegate_to: non-integer max_depth rejected", not ok, why)

    # ── can_delegate_to: no contract (always feasible if has subs) ─────
    ok, why = core.can_delegate_to(graph, "baal", "hermes", None)
    check("can_delegate_to: no contract, has subs", ok, why)

    ok, why = core.can_delegate_to(graph, "baal", "hermes", {})
    check("can_delegate_to: empty contract, has subs", ok, why)

    # ── Integration: can_communicate + can_delegate_to ─────────────────
    # Full path: edge check first, then delegation feasibility
    ok_edge, why_edge = core.can_communicate(graph, "baal", "hermes")
    ok_del, why_del = core.can_delegate_to(graph, "baal", "hermes")
    check("integration: baal→hermes edge AND delegation both ok",
          ok_edge and ok_del, f"edge={ok_edge}, del={ok_del}")

    ok_edge, why_edge = core.can_communicate(graph, "baal", "nyx")
    ok_del, why_del = core.can_delegate_to(graph, "baal", "nyx")
    check("integration: baal→nyx edge ok but delegation fails (leaf)",
          ok_edge and not ok_del, f"edge={ok_edge}, del={ok_del}")

    # ── Summary ────────────────────────────────────────────────────────
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
