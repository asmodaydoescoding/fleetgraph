#!/usr/bin/env python3
"""Issue #3 contract checks for Fleet Graph's live route-remount recovery."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "desktop-plugin" / "plugin.js").read_text(encoding="utf-8")

checks = {
    "recovery RPC names reload action": "action: 'reload_dashboard_routes'" in source,
    "recovery RPC requires explicit confirmation": "confirm: true" in source,
    "enabled backend exposes remount control": "Remount routes" in source,
    "remount success invalidates backend state": "['fleet-backend-state']" in source,
    "starter packs panel is mounted": "jsx(StarterPacksPanel, { nodes })" in source,
}

for name, passed in checks.items():
    print(f"[{'PASS' if passed else 'FAIL'}] {name}")

print(f"\nISSUE #3 SUMMARY: {sum(checks.values())}/{len(checks)} passed")
raise SystemExit(0 if all(checks.values()) else 1)
