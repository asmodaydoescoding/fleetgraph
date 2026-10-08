#!/usr/bin/env python3
"""Endpoint tests for the delegation feasibility check.

Locks in the API surface added by the delegation check:
  - POST /delegate-check  (read-only feasibility preview)
  - POST /send            (optional delegate_contract refusal path)

Runs against the real FastAPI router under an isolated fake fleet home, so
nothing touches the operator's live graph or inbox. Mirrors the harness setup
used by backend_loop8_test.py. fastapi is optional: the suite skips cleanly
when it is not installed.
"""
from __future__ import annotations

import hashlib
import importlib
import os
import sys
import tempfile
from pathlib import Path

import yaml

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:  # optional dependency: skip cleanly like the other gates
    print("DELEGATION ENDPOINT SUMMARY: skipped, fastapi is not installed")
    sys.exit(0)

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


with tempfile.TemporaryDirectory(prefix="fleet-delegate-endpoint-") as td:
    home = Path(td) / ".hermes"
    profiles = home / "profiles"
    inbox = home / "fleet-inbox"
    profiles.mkdir(parents=True)
    inbox.mkdir()
    graph_path = home / "fleet_graph.yaml"
    for name in ("captain", "relay-hub", "edge-worker", "leaf-a"):
        (profiles / name).mkdir()

    #       captain (profile: default)
    #        /        \
    #   relay-hub   edge-worker (leaf)
    #      |
    #   leaf-a (leaf)
    initial_doc = {
        "_meta": {
            "profile_aliases": {"captain": "default"},
            "root_owner_label": "operator",
            "relations": {},
        },
        "captain": {"subordinates": ["relay-hub", "edge-worker"]},
        "relay-hub": {"supervisor": "captain", "subordinates": ["leaf-a"]},
        "edge-worker": {"supervisor": "captain", "subordinates": []},
        "leaf-a": {"supervisor": "relay-hub", "subordinates": []},
    }
    graph_path.write_text(yaml.safe_dump(initial_doc, sort_keys=True))
    os.environ.update({
        "FLEET_HOME": str(home),
        "FLEET_GRAPH_PATH": str(graph_path),
        "FLEET_INBOX_DIR": str(inbox),
        "FLEET_PROFILES_DIR": str(profiles),
    })
    sys.path.insert(0, str(PLUGIN_DIR))
    for name in ("fleet_graph_core", "plugin_api"):
        sys.modules.pop(name, None)
    api = importlib.import_module("dashboard.plugin_api")
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/fleet-graph")
    client = TestClient(app)
    base = "/api/plugins/fleet-graph"

    def graph_digest() -> str:
        return hashlib.sha256(graph_path.read_bytes()).hexdigest()

    # ── /delegate-check: feasible ──────────────────────────────────────
    before = graph_digest()
    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "relay-hub"})
    check("/delegate-check feasible returns 200", r.status_code == 200,
          f"status={r.status_code} body={r.text[:120]}")
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check feasible ok=true", body.get("ok") is True, str(body))
    check("/delegate-check reports subtree_depth", body.get("subtree_depth") == 1,
          str(body))
    check("/delegate-check reports subtree_nodes",
          set(body.get("subtree_nodes") or []) == {"relay-hub", "leaf-a"},
          str(body))

    # ── /delegate-check: read-only ─────────────────────────────────────
    check("/delegate-check does not mutate the graph", graph_digest() == before)

    # ── /delegate-check: leaf refusal ──────────────────────────────────
    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "edge-worker"})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check leaf ok=false", body.get("ok") is False, str(body))
    check("/delegate-check leaf reason names the cause",
          "subordinate" in str(body.get("reason", "")).lower(), str(body))
    check("/delegate-check omits subtree fields when infeasible",
          "subtree_depth" not in body and "subtree_nodes" not in body, str(body))

    # ── /delegate-check: contract depth ────────────────────────────────
    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "relay-hub",
                          "contract": {"max_depth": 1}})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check contract max_depth met", body.get("ok") is True, str(body))

    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "relay-hub",
                          "contract": {"max_depth": 3}})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check contract max_depth unmet", body.get("ok") is False,
          str(body))

    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "relay-hub",
                          "contract": {"max_depth": "abc"}})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check non-integer max_depth refused", body.get("ok") is False,
          str(body))

    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "relay-hub",
                          "contract": {"max_depth": 0}})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check max_depth 0 refused", body.get("ok") is False, str(body))

    # ── /delegate-check: degenerate inputs ─────────────────────────────
    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "captain"})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check self-delegation refused", body.get("ok") is False,
          str(body))

    r = client.post(f"{base}/delegate-check",
                    json={"sender": "captain", "recipient": "ghost"})
    body = r.json() if r.status_code == 200 else {}
    check("/delegate-check unknown recipient refused", body.get("ok") is False,
          str(body))

    # ── POST /send: delegate_contract refusal path ─────────────────────
    before_inbox = sorted(p.name for p in inbox.glob("*.jsonl"))
    r = client.post(f"{base}/send", json={
        "to": "edge-worker", "kind": "delegate", "text": "unsatisfiable",
        "delegate_contract": {"max_depth": 1},
    })
    check("/send delegate_contract refusal returns 422", r.status_code == 422,
          f"status={r.status_code} body={r.text[:120]}")
    check("/send refusal names the delegation",
          "delegation refused" in r.text, r.text[:160])
    check("/send refusal writes no inbox message",
          sorted(p.name for p in inbox.glob("*.jsonl")) == before_inbox)

    # ── POST /send: satisfiable contract routes normally ───────────────
    r = client.post(f"{base}/send", json={
        "to": "relay-hub", "kind": "delegate", "text": "feasible delegation",
        "delegate_contract": {"max_depth": 1},
    })
    check("/send satisfiable contract returns 200", r.status_code == 200,
          f"status={r.status_code} body={r.text[:120]}")

    # ── POST /send: no contract keeps prior behavior (additive) ────────
    r = client.post(f"{base}/send", json={
        "to": "edge-worker", "kind": "delegate", "text": "no contract, unchanged",
    })
    check("/send without contract to leaf still routes (additive)",
          r.status_code == 200, f"status={r.status_code} body={r.text[:120]}")

    # ── summary ────────────────────────────────────────────────────────
    print(f"\nDELEGATION ENDPOINT SUMMARY: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
