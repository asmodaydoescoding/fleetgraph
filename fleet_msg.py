#!/usr/bin/env python3
"""fleet-msg — the ONLY sanctioned inter-bot channel. Validates the edge
against fleet_graph.yaml, then delivers via the standard Bot Chat transport.

Usage (from a bot or human):
  fleet-msg send --to worker --type done|question|escalate --summary "..." [--task ID] [--file MSG.txt]
  fleet-msg inbox [--profile P]     # drain messages addressed to P
  fleet-msg show                    # print the topology

Env: HERMES_PROFILE (set by `hermes -p`); falls back to --from.
"""
from __future__ import annotations

import argparse, json, os, shutil, subprocess, sys, tempfile, datetime, pathlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fleet_graph_core import (DEFAULT_PROFILE, FLEET_HOME, GraphError,
                              can_communicate, chain, describe,
                              graph_node_for_profile, load_graph,
                              load_relations, resolve_profile)  # noqa: E402

HERMES = FLEET_HOME
INBOX_DIR = pathlib.Path(os.environ.get(
    "FLEET_INBOX_DIR", str(HERMES / "fleet-inbox")
)).expanduser()
HERMES_BIN = os.environ.get("FLEET_HERMES_BIN") or shutil.which("hermes") or "hermes"


def _sender(args) -> str:
    return args.from_ or os.environ.get("HERMES_PROFILE") or DEFAULT_PROFILE


def _deliver_dm(target: str, body: str) -> bool:
    """Write via temp file (nothing shell-interpreted), then the standard
    Bot Chat transport used by Bot Mode DMs."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(body)
        path = f.name
    try:
        r = subprocess.run(
            [HERMES_BIN, "-p", target, "chat", "--in", "~", "-c", "Bot Chat",
             "--create-if-missing", "-Q", "--query-file", path],
            capture_output=True, text=True, timeout=600)
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        os.unlink(path)


def cmd_send(args):
    try:
        graph = load_graph()
        relations = load_relations()
    except GraphError as e:
        # corrupt/cyclic topology: refuse cleanly in the JSON contract bots
        # parse — never a raw traceback on stderr.
        print(json.dumps({"ok": False, "error": f"fleet graph unusable: {e}"}))
        sys.exit(2)
    sender_raw = _sender(args)
    sender = graph_node_for_profile(sender_raw, graph) or sender_raw
    target_node = graph_node_for_profile(args.to, graph) or args.to
    ok, why = can_communicate(graph, sender, target_node, relations)
    if not ok:
        print(json.dumps({"ok": False, "error": why}))
        sys.exit(2)

    target_profile = resolve_profile(target_node)
    body = args.summary or ""
    if args.file:
        body += "\n\n" + pathlib.Path(args.file).read_text()
    if not body.strip():
        print(json.dumps({"ok": False, "error": "empty message (--summary or --file)"}))
        sys.exit(2)

    edge_kind = {"down": "supervisor", "up": "subordinate", "peer": "peer"}[why]
    header = (f"Message from \U0001F916 {sender} ({edge_kind}):\n"
              f"type: {args.type}" + (f" | task: {args.task}" if args.task else "") + "\n\n")
    full = header + body

    # 1. inbox file (durable, drainable) — always the primary transport.
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    inbox = INBOX_DIR / f"{target_profile}.jsonl"
    rec = {"ts": datetime.datetime.utcnow().isoformat() + "Z", "from": sender,
           "to": target_node, "type": args.type, "task": args.task,
           "summary": (args.summary or "")[:500]}
    with open(inbox, "a") as f:
        f.write(json.dumps(rec) + "\n")

    # 2. live delivery is OPT-IN (--deliver): it boots the target profile and
    #    runs a full agent turn, which blocks the sender for minutes. The
    #    normal flow is inbox-only; supervisors drain on their routine.
    delivered = None
    if args.deliver:
        delivered = _deliver_dm(target_profile, full)

    out = {"ok": True, "edge": why, "to": target_node,
           "profile": target_profile, "inbox": str(inbox)}
    if delivered is not None:
        out["delivered"] = delivered
    print(json.dumps(out))


def cmd_inbox(args):
    requested = args.profile or _sender(args)
    try:
        profile = resolve_profile(requested)
    except GraphError:
        profile = requested
    inbox = INBOX_DIR / f"{profile}.jsonl"
    if not inbox.exists():
        print(json.dumps({"profile": requested, "messages": []}))
        return
    # skip malformed lines (partial writes, corruption) — never crash on them
    lines = []
    for l in inbox.read_text().splitlines():
        l = l.strip()
        if not l:
            continue
        try:
            lines.append(json.loads(l))
        except Exception:
            continue
    print(json.dumps({"profile": requested, "messages": lines}))
    if args.drain:
        inbox.unlink()


def cmd_show(_args):
    graph = load_graph()
    relations = load_relations()
    d = describe(graph, relations)
    print(json.dumps(d, indent=1))


def main():
    p = argparse.ArgumentParser(prog="fleet-msg")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send")
    s.add_argument("--to", required=True)
    s.add_argument("--type", default="update", choices=["done", "question", "escalate", "update", "assign"])
    s.add_argument("--task", default=None)
    s.add_argument("--summary", default="")
    s.add_argument("--file", default=None)
    s.add_argument("--from", dest="from_", default=None)
    s.add_argument("--deliver", action="store_true",
                   help="also run a live agent turn in the target (BLOCKING, minutes). "
                        "Default records to the target's inbox only.")
    s.set_defaults(fn=cmd_send)

    i = sub.add_parser("inbox")
    i.add_argument("--profile", default=None)
    i.add_argument("--drain", action="store_true")
    i.set_defaults(fn=cmd_inbox)

    d = sub.add_parser("show")
    d.set_defaults(fn=cmd_show)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
