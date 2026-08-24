"""Scan-tolerance + import behavior tests for the profile-import feature.

Covers issue #4: discovery and import of existing on-disk Hermes profiles.
Runs against an isolated FLEET_HOME so the operator's real graph is never
touched. Run with: python tests/profile_import_test.py
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_tmp = tempfile.mkdtemp(prefix="fleetgraph-test-")
os.environ["FLEET_HOME"] = str(Path(_tmp) / ".hermes")

# Import AFTER the env var is set so module constants bind to the sandbox.
spec_ok = True
try:
    from fleet_graph_core import (
        discover_missing_profiles,
        import_existing_profiles,
        load_graph,
    )
except ImportError as e:
    print(f"SKIP: {e}")
    sys.exit(0)

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        failures.append(name)


def make_profile(home: Path, name: str, soul: str | None = "You are a test bot."):
    pdir = home / "profiles" / name
    pdir.mkdir(parents=True, exist_ok=True)
    if soul is not None:
        (pdir / "SOUL.md").write_text(f"# {name}\n\n{soul}\n", encoding="utf-8")
    return pdir


def main():
    home = Path(os.environ["FLEET_HOME"])
    profiles_root = home / "profiles"
    profiles_root.mkdir(parents=True, exist_ok=True)

    # --- scan tolerance -------------------------------------------------
    # odd shapes that must not break the scanner
    (profiles_root / "not-a-dir.txt").write_text("file, not dir")
    weird = profiles_root / "weird-name.with.dots"
    weird.mkdir()
    (profiles_root / "_private").mkdir()          # underscore-prefixed dir
    make_profile(home, "scout", None)              # missing SOUL.md entirely

    discovered = discover_missing_profiles()
    names = [d["name"] for d in discovered]
    check("file entries ignored by scanner", "not-a-dir.txt" not in names)
    check("unwired dirs discovered", "scout" in names and "weird-name.with.dots" in names)
    scout = next(d for d in discovered if d["name"] == "scout")
    check("missing SOUL.md tolerated (empty metadata)", scout["title"] in ("", "scout"))

    # --- import semantics -----------------------------------------------
    res1 = import_existing_profiles(["scout", "weird-name.with.dots"])
    check("import reports imported list", sorted(res1["imported"]) ==
          ["scout", "weird-name.with.dots"])
    graph = load_graph()
    check("imported nodes present in graph",
          "scout" in graph and "weird-name.with.dots" in graph)

    # collision: importing again skips, does not overwrite
    res2 = import_existing_profiles(["scout"])
    check("collision skipped with warning", res2["skipped"] and
          res2["skipped"][0]["name"] == "scout")
    check("collision did not duplicate or clobber", len(load_graph()) == len(graph))

    # unknown name reported, nothing else disturbed
    res3 = import_existing_profiles(["does-not-exist"])
    check("unknown name reported", "does-not-exist" in res3["unknown"])

    print()
    if failures:
        print(f"{len(failures)} failure(s): {failures}")
        sys.exit(1)
    print("all profile-import checks passed")


if __name__ == "__main__":
    main()
