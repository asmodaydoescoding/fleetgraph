#!/usr/bin/env python3
"""Regression coverage for graph-send activation vs inbox-only transport."""
from __future__ import annotations

import importlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

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


with tempfile.TemporaryDirectory(prefix="fleet-communication-") as td:
    root = Path(td)
    home = root / ".hermes"
    profiles = home / "profiles"
    inbox = home / "fleet-inbox"
    home.mkdir()
    profiles.mkdir()
    inbox.mkdir()
    for name in ("worker-a", "worker-b"):
        (profiles / name).mkdir()

    log_path = root / "live-invocation.json"
    fake_hermes = root / "fake-hermes"
    fake_hermes.write_text(
        "#!/usr/bin/env python3\n"
        "import json, pathlib, sys\n"
        "args = sys.argv[1:]\n"
        "query = pathlib.Path(args[args.index('--query-file') + 1]).read_text()\n"
        f"pathlib.Path({str(log_path)!r}).write_text(json.dumps({{'args': args, 'query': query}}))\n"
    )
    fake_hermes.chmod(fake_hermes.stat().st_mode | stat.S_IXUSR)

    graph_path = home / "fleet_graph.yaml"
    graph_path.write_text(yaml.safe_dump({
        "default": {"subordinates": ["worker-a", "worker-b"]},
        "worker-a": {"supervisor": "default", "subordinates": []},
        "worker-b": {"supervisor": "default", "subordinates": []},
        "_meta": {"relations": {"worker-a": ["worker-b"]}},
    }))
    os.environ.update({
        "FLEET_HOME": str(home),
        "FLEET_GRAPH_PATH": str(graph_path),
        "FLEET_INBOX_DIR": str(inbox),
        "FLEET_PROFILES_DIR": str(profiles),
        "FLEET_DEFAULT_PROFILE": "default",
        "FLEET_HERMES_BIN": str(fake_hermes),
    })
    for name in ("fleet_graph_core", "dashboard.plugin_api"):
        sys.modules.pop(name, None)
    sys.path.insert(0, str(PLUGIN_DIR))
    api = importlib.import_module("dashboard.plugin_api")
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/fleet-graph")
    client = TestClient(app)
    base = "/api/plugins/fleet-graph"

    live = client.post(f"{base}/send", json={
        "to": "worker-a",
        "recipient": "worker-b",
        "kind": "talk",
        "live": True,
        "text": "coordinate the handoff",
    })
    check("live graph send is accepted", live.status_code == 200, live.text)
    live_body = live.json()
    check("live send reports queued activation",
          live_body.get("delivery", {}).get("state") == "queued",
          live.text)

    for _ in range(40):
        if log_path.exists():
            break
        time.sleep(0.025)
    invocation = json.loads(log_path.read_text()) if log_path.exists() else {}
    args = invocation.get("args", [])
    query = invocation.get("query", "")
    check("queued process targets the recipient profile",
          args[args.index("-p") + 1] == "worker-b" if "-p" in args else False,
          repr(args))
    check("queued process receives the framed message",
          "frame: talk" in query and "coordinate the handoff" in query,
          repr(query))

    record = json.loads((inbox / "worker-b.jsonl").read_text().splitlines()[0])
    check("inbox remains the durable audit copy", record.get("live_requested") is True, repr(record))

    inbox_only = client.post(f"{base}/send", json={
        "to": "worker-a",
        "recipient": "worker-b",
        "kind": "talk",
        "text": "queue for the next routine",
    })
    check("inbox-only send still works", inbox_only.status_code == 200, inbox_only.text)
    check("inbox-only send does not claim a live turn",
          inbox_only.json().get("delivery") == {"mode": "inbox", "state": "recorded"},
          inbox_only.text)

    api.HERMES_BIN = str(root / "missing-hermes")
    failed_live = client.post(f"{base}/send", json={
        "to": "worker-a",
        "recipient": "worker-b",
        "kind": "talk",
        "live": True,
        "text": "activation failure still preserves this",
    })
    check("failed activation keeps the HTTP send successful", failed_live.status_code == 200, failed_live.text)
    check("failed activation is explicit instead of false success",
          failed_live.json().get("delivery", {}).get("state") == "failed",
          failed_live.text)

    # Alias-only graph: canonical Hermes profile must resolve to its graph node,
    # while inbox storage remains canonical for the recipient process.
    graph_path.write_text(yaml.safe_dump({
        "captain": {"subordinates": ["worker-a"]},
        "worker-a": {"supervisor": "captain", "subordinates": []},
        "_meta": {
            "relations": {},
            "profile_aliases": {"captain": "default"},
        },
    }))
    alias_api = client.post(f"{base}/send", json={
        "to": "worker-a",
        "kind": "delegate",
        "text": "alias sender reaches subordinate",
    })
    check("dashboard resolves canonical sender through graph alias",
          alias_api.status_code == 200 and alias_api.json().get("sender") == "captain",
          alias_api.text)

    alias_cli = subprocess.run([
        sys.executable, str(PLUGIN_DIR / "fleet_msg.py"), "send",
        "--to", "worker-a", "--from", "default",
        "--summary", "CLI alias route probe",
    ], env=os.environ.copy(), text=True, capture_output=True)
    alias_cli_body = json.loads(alias_cli.stdout or "{}")
    check("CLI resolves canonical sender through graph alias",
          alias_cli.returncode == 0 and alias_cli_body.get("to") == "worker-a",
          json.dumps({"returncode": alias_cli.returncode, "stdout": alias_cli.stdout,
                      "stderr": alias_cli.stderr}))
    check("CLI alias delivery stays in canonical inbox",
          (inbox / "worker-a.jsonl").exists() and
          not (inbox / "captain.jsonl").exists(),
          str(sorted(p.name for p in inbox.glob("*.jsonl"))))

print(f"\nCOMMUNICATION LIVE SUMMARY: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
