#!/usr/bin/env python3
"""Fail-closed validation contract for optional Fleet Graph starter packs."""
from pathlib import Path
import shutil
import sys
import tempfile
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from starter_pack import PackValidationError, load_pack, selected_actions  # noqa: E402

SOURCE = ROOT / "starter-packs" / "starfleet-complement"


def copied_pack() -> Path:
    temp = Path(tempfile.mkdtemp(prefix="fleet-pack-test-"))
    target = temp / "starfleet-complement"
    shutil.copytree(SOURCE, target)
    return target


def rewrite_manifest(root: Path, mutate) -> None:
    path = root / "pack.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def rewrite_topology(root: Path, mutate) -> None:
    path = root / "fleet_graph.example.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def expect_invalid(root: Path, available=None) -> None:
    try:
        load_pack(root, available_profiles=available or {"default"})
    except PackValidationError:
        return
    raise AssertionError("pack unexpectedly validated")


def main() -> None:
    valid = load_pack(SOURCE, available_profiles={"default"})
    assert len(valid["profiles"]) == 75
    assert len(valid["topology"]) == 75
    actions = selected_actions(valid, ["default", "baal"])
    assert actions == [
        {"name": "default", "action": "adopt", "clone_from": None},
        {"name": "baal", "action": "create", "clone_from": "default"},
    ]

    traversal = copied_pack()
    rewrite_manifest(traversal, lambda d: d.__setitem__("topology", "../outside.yaml"))
    expect_invalid(traversal)

    checksum = copied_pack()
    rewrite_topology(checksum, lambda d: d["baal"].__setitem__("title", "tampered"))
    expect_invalid(checksum)

    unsupported = copied_pack()
    rewrite_manifest(unsupported, lambda d: d.__setitem__("runs", "installer.sh"))
    expect_invalid(unsupported)

    duplicate = copied_pack()
    rewrite_manifest(duplicate, lambda d: d["profiles"].append({"name": "baal", "clone_from": "default"}))
    expect_invalid(duplicate)

    unknown_source = copied_pack()
    rewrite_manifest(unknown_source, lambda d: d["profiles"][0].__setitem__("clone_from", "missing-source"))
    expect_invalid(unknown_source)

    cycle = copied_pack()
    rewrite_topology(cycle, lambda d: d["baal"].__setitem__("supervisor", "baal"))
    expect_invalid(cycle)

    print("STARTER PACK SUMMARY: 7/7 passed")


if __name__ == "__main__":
    main()
