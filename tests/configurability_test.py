#!/usr/bin/env python3
"""Release configurability gate for shipped fleet-graph runtime files."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import yaml

PLUGIN_DIR = Path(__file__).resolve().parents[1]
FRONTEND = PLUGIN_DIR / "desktop-plugin" / "plugin.js"
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
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


DEFAULT_ABSENCE_MAP = {
    "core_seed_names": ["unset-core-seed-placeholder"],
    "operator_names": ["unset-operator-placeholder"],
}


def load_absence_map() -> tuple[dict[str, list[str]], str]:
    """Load the externalized private absence lists, or generic defaults.

    Values loaded from FLEET_ABSENCE_MAP are never printed; only the mode
    ("external" vs "default-generic") is reported in output details.
    """
    raw_path = os.environ.get("FLEET_ABSENCE_MAP")
    if not raw_path:
        copied = {key: list(names) for key, names in DEFAULT_ABSENCE_MAP.items()}
        return copied, "default-generic"
    data = json.loads(Path(raw_path).expanduser().read_text(encoding="utf-8"))
    return {
        "core_seed_names": [str(name) for name in data.get("core_seed_names", [])],
        "operator_names": [str(name) for name in data.get("operator_names", [])],
    }, "external"


with tempfile.TemporaryDirectory(prefix="fleet-config-") as td:
    home = Path(td) / "fleet-config-home"
    home.mkdir()
    graph_path = home / "fleet_graph.yaml"
    os.environ["FLEET_HOME"] = str(home)
    os.environ["FLEET_GRAPH_PATH"] = str(graph_path)

    core = load_module("fleet_graph_core_config_test", PLUGIN_DIR / "fleet_graph_core.py")

    # A release install cannot seed another operator's private fleet.
    try:
        fresh_graph = core.load_graph()
        fresh_relations = core.load_relations()
    except Exception as exc:
        fresh_graph, fresh_relations = {"error": str(exc)}, {"error": str(exc)}
    check("fresh install starts with a generic empty graph", fresh_graph == {}, repr(fresh_graph))
    check("fresh install starts with no private peer relations", fresh_relations == {}, repr(fresh_relations))

    # Explicit metadata maps a graph-facing alias to the real Hermes profile.
    graph_path.write_text(yaml.safe_dump({
        "_meta": {
            "relations": {},
            "profile_aliases": {"captain": "default"},
            "root_owner_label": "the operator",
        },
        "captain": {"subordinates": ["worker"]},
        "worker": {"supervisor": "captain", "subordinates": []},
    }, sort_keys=True))
    (home / "profiles" / "worker").mkdir(parents=True)

    try:
        aliases = core.load_profile_aliases()
        resolved = core.resolve_profile("captain")
        graph = core.load_graph()
        graph_node = core.graph_node_for_profile("default", graph)
    except Exception as exc:
        aliases, resolved, graph_node = {}, f"error:{exc}", None
        graph = {}
    check("profile aliases load from graph metadata", aliases == {"captain": "default"}, repr(aliases))
    check("graph alias resolves to canonical default profile", resolved == "default", repr(resolved))
    check("canonical profile resolves back to graph node", graph_node == "captain", repr(graph_node))

    try:
        core.save_graph(graph, relations={})
        saved_meta = (yaml.safe_load(graph_path.read_text()) or {}).get("_meta", {})
    except Exception as exc:
        saved_meta = {"error": str(exc)}
    check("graph save preserves profile alias metadata",
          saved_meta.get("profile_aliases") == {"captain": "default"}, repr(saved_meta))
    check("graph save preserves operator label metadata",
          saved_meta.get("root_owner_label") == "the operator", repr(saved_meta))

    # Load the API against the fake installation, sharing the configured core.
    sys.modules["fleet_graph_core"] = core
    try:
        api = load_module(
            "fleet_graph_plugin_api_config_test", PLUGIN_DIR / "dashboard" / "plugin_api.py"
        )
        api_loaded = True
    except ModuleNotFoundError as exc:
        api, api_loaded = None, False
        print(f"[SKIP] backend API configurability checks ({exc.name} not installed)")
    if api_loaded:
        check("backend storage root honors FLEET_HOME", api.HERMES == home, f"got {api.HERMES}")
        check("alias profile directory resolves to fake default home",
              api._profile_dir("captain") == home, repr(api._profile_dir("captain")))

        try:
            overview = api.overview(light="1")
            nodes = overview.get("nodes", {})
        except Exception as exc:
            nodes = {"error": str(exc)}
        check("overview emits graph alias once without duplicate default node",
              "captain" in nodes and "default" not in nodes, repr(sorted(nodes)))
        check("overview exposes canonical profile identity",
              nodes.get("captain", {}).get("profile") == "default", repr(nodes.get("captain")))

        try:
            sent = api.fleet_send(api.FleetSend(to="worker", text="bounded task", kind="delegate"))
        except Exception as exc:
            sent = {"error": str(exc)}
        check("delegate sender resolves from configured operator graph node",
              sent.get("sender") == "captain" and sent.get("recipient") == "worker", repr(sent))

frontend = FRONTEND.read_text()
core_src = (PLUGIN_DIR / "fleet_graph_core.py").read_text()
api_src = (PLUGIN_DIR / "dashboard" / "plugin_api.py").read_text()
prompt_src = (PLUGIN_DIR / "__init__.py").read_text()
cli_src = (PLUGIN_DIR / "fleet_msg.py").read_text()
runtime_src = "\n".join((core_src, api_src, prompt_src, cli_src))

absence_map, absence_mode = load_absence_map()
core_seed_names = absence_map["core_seed_names"]
operator_names = absence_map["operator_names"]

frontend_branches = [
    name for name in core_seed_names
    if re.search(r"(?:===|\[)\s*['\"]" + re.escape(name) + r"['\"]", frontend)
]
check("frontend has no operator-specific alias branch",
      not frontend_branches,
      f"{len(frontend_branches)} operator-specific alias branch(es) remain"
      f" (map={absence_mode})")
backend_branches = [
    name for name in core_seed_names
    if re.search(r"(?:==|\()\s*['\"]" + re.escape(name) + r"['\"]", api_src)
]
check("backend has no operator-specific alias branch",
      not backend_branches,
      f"{len(backend_branches)} operator-specific alias branch(es) remain"
      f" (map={absence_mode})")
check("fresh-install core contains no private fleet seed names",
      not any(name in core_src for name in core_seed_names))
check("prompt section contains no private operator name",
      not any(name in prompt_src for name in operator_names))
check("CLI does not hardcode the Hermes venv executable", "hermes-agent/venv/bin/hermes" not in cli_src)
check("shipped runtime contains no private fleet identity examples",
      not any(name in runtime_src for name in core_seed_names))
raw_colors = re.findall(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsl\([^)]*\)", frontend)
check("frontend uses theme tokens instead of literal colors", not raw_colors,
      repr(raw_colors[:8]))
host_styles_env = os.environ.get("FLEET_HOST_STYLES")
if host_styles_env is None:
    print("[SKIP] host style token parity (FLEET_HOST_STYLES unset)")
else:
    host_styles_path = Path(host_styles_env).expanduser()
    if not host_styles_path.is_file():
        print("[SKIP] host style token parity (FLEET_HOST_STYLES path not found)")
    else:
        host_styles = host_styles_path.read_text()
        plugin_defs = set(re.findall(r"(--[a-z0-9-]+)\s*:", frontend))
        host_defs = set(re.findall(r"(--[a-z0-9-]+)\s*:", host_styles))
        plugin_refs = set(re.findall(r"var\((--[a-z0-9-]+)", frontend))
        missing_theme_tokens = sorted(plugin_refs - plugin_defs - host_defs)
        check("frontend references only real host or plugin-defined theme tokens",
              not missing_theme_tokens, repr(missing_theme_tokens))
weak_text_tokens = re.findall(r"text-\(--ui-text-(?:tertiary|quaternary)\)(?:/\d+)?", frontend)
check("small frontend text does not use sub-AA tertiary/quaternary tokens",
      not weak_text_tokens, repr(weak_text_tokens[:8]))
check("accent-filled controls use theme-selected foreground, not fixed white",
      "text-white" not in frontend)

print(f"\nCONFIGURABILITY SUMMARY: {passed} passed, {failed} failed (map={absence_mode})")
sys.exit(1 if failed else 0)
