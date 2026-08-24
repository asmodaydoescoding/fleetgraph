#!/usr/bin/env python3
"""Deterministic demo Fleetgraph generator (module + CLI).

Emits a complete, valid Fleetgraph document as JSON for demos, docs and
smoke tests. The output is fully reproducible:

- every node, relation and alias below is fixed data — no clock, no RNG,
  no environment-dependent values anywhere in the pipeline;
- keys are emitted in sorted order and lists are pre-sorted, so the bytes
  are identical across runs (and across PYTHONHASHSEED values);
- the tree is validated through the real core (`normalize` +
  `normalize_relations`) before rendering, so an emitted document always
  loads cleanly via `fleet_graph_core.load_graph`.

Storage layout (matches what `fleet_graph_core.save_graph` writes):

    _meta:
      profile_aliases: {graph-facing name -> canonical Hermes profile}
      relations:       {node -> [peers]}   # symmetric, both directions
    <node>:
      subordinates: [...]                 # derived, kept sorted here
      supervisor: ...                     # absent on the root

CLI:

    python3 scripts/build_demo_fleet.py            # compact JSON to stdout
    python3 scripts/build_demo_fleet.py --pretty   # indented JSON to stdout
    python3 scripts/build_demo_fleet.py --out PATH # write to PATH instead
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

import fleet_graph_core as core  # noqa: E402  (build-time validation only)

# ---------------------------------------------------------------------------
# Fixed fleet definition. Deliberately neutral role names; edit by hand only.
# ---------------------------------------------------------------------------

ROOT = "fleet-control"

#: node -> supervisor. The root is intentionally absent from this map.
SUPERVISORS = {
    "relay-hub-north": ROOT,
    "edge-worker-one": "relay-hub-north",
    "edge-worker-two": "relay-hub-north",
    "edge-worker-epsilon": "relay-hub-north",
    "relay-hub-south": ROOT,
    "edge-worker-three": "relay-hub-south",
    "edge-worker-four": "relay-hub-south",
    "telemetry-store": ROOT,
    "archive-indexer": "telemetry-store",
}

#: peer edges, declared once here; emitted symmetrically (both directions),
#: exactly like `save_graph` persists them.
PEER_EDGES = [
    ("relay-hub-north", "relay-hub-south"),
    ("telemetry-store", "relay-hub-south"),
    ("archive-indexer", "edge-worker-four"),
]

#: graph-facing node name -> canonical Hermes profile (one default alias).
PROFILE_ALIASES = {
    "fleet-control": "default",
}


def build_document() -> dict:
    """Return the demo fleet as a plain dict in persisted storage layout."""
    names = sorted({ROOT, *SUPERVISORS})
    graph = {name: {} for name in names}
    for child, supervisor in SUPERVISORS.items():
        graph[child]["supervisor"] = supervisor

    normalized = core.normalize(graph)
    rel_input = {left: [right] for left, right in PEER_EDGES}
    relations = core.normalize_relations(rel_input, normalized)

    # Canonical emission shape: sorted subordinates, supervisor omitted on
    # the root — independent of dict iteration order.
    nodes: dict[str, dict] = {}
    for name in sorted(normalized):
        node = normalized[name]
        entry = {"subordinates": sorted(node.get("subordinates", []))}
        supervisor = node.get("supervisor")
        if supervisor:
            entry["supervisor"] = supervisor
        nodes[name] = entry

    document: dict = {
        "_meta": {
            "profile_aliases": dict(sorted(PROFILE_ALIASES.items())),
            "relations": relations,
        },
    }
    document.update(nodes)
    return document


def render(document: dict, pretty: bool = False) -> str:
    """Serialize deterministically: sorted keys, explicit separators, LF end."""
    if pretty:
        text = json.dumps(
            document, sort_keys=True, indent=2,
            ensure_ascii=True, allow_nan=False,
        )
    else:
        text = json.dumps(
            document, sort_keys=True, separators=(",", ":"),
            ensure_ascii=True, allow_nan=False,
        )
    return text + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="build_demo_fleet.py",
        description="Emit the deterministic demo Fleetgraph as JSON.",
    )
    parser.add_argument(
        "--pretty", action="store_true",
        help="indent the JSON instead of emitting compact bytes",
    )
    parser.add_argument(
        "--out", type=Path, default=None, metavar="PATH",
        help="write to PATH instead of stdout (parent dirs are created)",
    )
    args = parser.parse_args(argv)

    try:
        document = build_document()
    except core.GraphError as exc:
        print(f"error: generated demo fleet is not a valid graph: {exc}",
              file=sys.stderr)
        return 1

    payload = render(document, pretty=args.pretty)
    if args.out is None:
        sys.stdout.write(payload)
    else:
        out_path = args.out.expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
