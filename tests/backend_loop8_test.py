#!/usr/bin/env python3
"""Loop-8 backend adversarial seams, isolated under a fake fleet home."""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:  # optional dependency: skip cleanly like the other gates
    print("BACKEND LOOP8 SUMMARY: skipped, fastapi is not installed")
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


with tempfile.TemporaryDirectory(prefix="fleet-loop8-backend-") as td:
    home = Path(td) / ".hermes"
    profiles = home / "profiles"
    inbox = home / "fleet-inbox"
    profiles.mkdir(parents=True)
    inbox.mkdir()
    graph_path = home / "fleet_graph.yaml"
    for name in ("relay-hub", "edge-worker", "pngbot", "webpbot", "dirbot", "purge-me"):
        (profiles / name).mkdir()

    initial_doc = {
        "_meta": {
            "profile_aliases": {"captain": "default"},
            "root_owner_label": "operator",
            "relations": {"relay-hub": ["edge-worker"]},
        },
        "captain": {"subordinates": ["relay-hub", "pngbot", "webpbot", "dirbot", "purge-me"]},
        "relay-hub": {"supervisor": "captain", "subordinates": []},
        "edge-worker": {"subordinates": []},
        "pngbot": {"supervisor": "captain", "subordinates": []},
        "webpbot": {"supervisor": "captain", "subordinates": []},
        "dirbot": {"supervisor": "captain", "subordinates": []},
        "purge-me": {"supervisor": "captain", "subordinates": []},
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
    core = importlib.import_module("fleet_graph_core")
    api = importlib.import_module("dashboard.plugin_api")
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/fleet-graph")
    client = TestClient(app)
    base = "/api/plugins/fleet-graph"

    # Recipient staleness: the UI picked edge-worker while it was a peer. The current
    # graph removes that relation before POST, so the server must refuse it.
    graph_nodes = {
        name: {"supervisor": node.get("supervisor"), "subordinates": node.get("subordinates", [])}
        for name, node in core.load_graph().items()
    }
    update = client.put(f"{base}/graph", json={"nodes": graph_nodes, "relations": {}})
    before_files = sorted(inbox.glob("*.jsonl"))
    stale_send = client.post(f"{base}/send", json={
        "to": "relay-hub", "kind": "talk", "recipient": "edge-worker", "text": "stale pick",
    })
    after_files = sorted(inbox.glob("*.jsonl"))
    check("stale talk recipient is revalidated against current relations",
          update.status_code == 200 and stale_send.status_code == 422,
          f"put={update.status_code} send={stale_send.status_code} body={stale_send.text[:160]}")
    check("refused stale recipient writes no inbox", before_files == after_files)

    # Simulate the built-in Bots/Profiles delete: the profile directory is
    # removed outside this plugin while the separate topology file is stale.
    (profiles / "purge-me").rmdir()
    after_profile_delete = api.overview(light="1")
    check("overview reconciles an externally deleted profile",
          "purge-me" not in after_profile_delete["nodes"] and
          "purge-me" not in core.load_graph(),
          f"nodes={sorted(after_profile_delete['nodes'])}")
    stale_readd = api.put_graph(api.GraphUpdate(nodes={
        "purge-me": api.NodeUpdate(supervisor="captain"),
    }))
    check("stale graph save cannot resurrect deleted profile",
          "purge-me" not in core.load_graph() and
          "purge-me" not in stale_readd["graph"],
          f"graph={sorted(stale_readd['graph'])}")

    # Explicit hierarchy removal removes only the graph node. The profile
    # directory remains available for later re-import, while the parent edge
    # is updated in the same atomic request.
    remove_response = client.put(f"{base}/graph", json={
        "nodes": {"captain": {"subordinates": ["relay-hub", "webpbot", "dirbot"]}},
        "relations": {}, "remove": ["pngbot"],
    })
    removed_graph = core.load_graph()
    check("leaf removal drops graph node but retains profile",
          remove_response.status_code == 200 and "pngbot" not in removed_graph and
          (profiles / "pngbot").is_dir(),
          f"status={remove_response.status_code} nodes={sorted(removed_graph)}")

    # Avatar extension determines the data-URI MIME; occupied directory shapes
    # are ignored instead of read as files.
    png_assets = profiles / "pngbot" / "assets"
    png_assets.mkdir()
    (png_assets / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\nfixture")
    webp_assets = profiles / "webpbot" / "assets"
    webp_assets.mkdir()
    (webp_assets / "avatar.webp").write_bytes(b"RIFFfixtureWEBP")
    dir_assets = profiles / "dirbot" / "assets"
    dir_assets.mkdir()
    (dir_assets / "avatar.png").mkdir()
    png_resp = client.get(f"{base}/avatar/pngbot")
    webp_resp = client.get(f"{base}/avatar/webpbot")
    dir_resp = client.get(f"{base}/avatar/dirbot")
    check("PNG avatar reports image/png data URI",
          png_resp.status_code == 200 and png_resp.json().get("data", "").startswith("data:image/png;base64,"))
    check("WebP avatar reports image/webp data URI",
          webp_resp.status_code == 200 and webp_resp.json().get("data", "").startswith("data:image/webp;base64,"))
    check("avatar path occupied by a directory degrades to found=false",
          dir_resp.status_code == 200 and dir_resp.json() == {"found": False}, dir_resp.text)

    # Query bounds must be HTTP contracts, not silent clamping that disappears
    # when the profile has no latest session.
    for value in (0, -1, 101, 10_000_000):
        response = client.get(f"{base}/sessions/relay-hub/messages?limit={value}")
        check(f"session message limit {value} is rejected", response.status_code == 422,
              f"status={response.status_code} body={response.text[:120]}")
    valid_limit = client.get(f"{base}/sessions/relay-hub/messages?limit=100")
    check("session message limit upper bound 100 is accepted", valid_limit.status_code == 200)

    # Watermark timestamp is informational; count_at_read is authoritative and
    # unread arithmetic remains clamped for future/past/oversized states.
    target_inbox = inbox / "relay-hub.jsonl"
    target_inbox.write_text("".join(json.dumps({"ts": f"2026-01-01T00:00:0{i}Z"}) + "\n" for i in range(3)))
    api.WATERMARK_DIR.mkdir(parents=True, exist_ok=True)
    wm_file = api.WATERMARK_DIR / "relay-hub.json"
    wm_file.write_text(json.dumps({"last_read_ts": "2999-01-01T00:00:00Z", "count_at_read": 2}))
    check("future watermark timestamp keeps unread math sane", api._unread_counts().get("relay-hub") == 1)
    wm_file.write_text(json.dumps({"last_read_ts": "1900-01-01T00:00:00Z", "count_at_read": 99}))
    check("oversized old watermark count clamps unread at zero", api._unread_counts().get("relay-hub") == 0)

    # Readers race atomic full-document replacements. Any parse error, partial
    # topology, missing metadata, or non-200 read is a failure.
    variants = []
    for index in range(2):
        suffix = f"worker-{index}"
        (profiles / suffix).mkdir()
        variants.append({
            "captain": {"supervisor": None, "subordinates": [suffix]},
            suffix: {"supervisor": "captain", "subordinates": []},
        })

    # Two savers must use distinct temporary files. Synchronize both inside
    # yaml.safe_dump after their temp files are open; a shared fixed .tmp path
    # makes the second os.replace fail deterministically.
    original_dump = core.yaml.safe_dump
    dump_barrier = threading.Barrier(2)

    def synchronized_dump(*args, **kwargs):
        dump_barrier.wait(timeout=5)
        return original_dump(*args, **kwargs)

    core.yaml.safe_dump = synchronized_dump
    saver_errors: list[str] = []

    def one_write(index: int) -> None:
        try:
            core.save_graph(variants[index], relations={})
        except Exception as exc:
            saver_errors.append(str(exc))

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(one_write, 0), pool.submit(one_write, 1)]
        for future in futures:
            future.result()
    core.yaml.safe_dump = original_dump
    try:
        post_race_graph = core.load_graph()
    except Exception as exc:
        saver_errors.append(f"reload:{exc}")
        post_race_graph = {}
    check("simultaneous graph saves use collision-safe temp files",
          not saver_errors and set(post_race_graph) in (
              {"captain", "worker-0"}, {"captain", "worker-1"}),
          "; ".join(saver_errors[:3]) or repr(sorted(post_race_graph)))

    errors: list[str] = []
    api.put_graph(api.GraphUpdate(nodes=variants[0], relations={}))

    def saver() -> None:
        for index in range(80):
            try:
                api.put_graph(api.GraphUpdate(nodes=variants[index % 2], relations={}))
            except Exception as exc:
                errors.append(f"saver:{exc}")

    def reader() -> None:
        # PUT /graph MERGES payload over disk (stale-client protection):
        # the pre-loop save seeds {captain, worker-0}; later alternating
        # saves may add worker-1 but nothing ever shrinks the set. Any
        # other shape = a torn or lost write.
        for _ in range(160):
            try:
                payload = api.overview(light="1")
                graph_names = {name for name, node in payload["nodes"].items() if node.get("in_graph")}
                if graph_names not in (
                    {"captain", "worker-0"},
                    {"captain", "worker-0", "worker-1"},
                ):
                    errors.append(f"reader-shape:{sorted(graph_names)}")
                if core.load_profile_aliases() != {"captain": "default"}:
                    errors.append("reader-alias-metadata-lost")
            except Exception as exc:
                errors.append(f"reader:{exc}")

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(saver), pool.submit(reader), pool.submit(reader)]
        for future in futures:
            future.result()
    check("overview never observes torn YAML during concurrent PUT", not errors,
          "; ".join(errors[:5]))

print(f"\nBACKEND LOOP8 SUMMARY: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
