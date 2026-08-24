"""Regression contracts for starter-pack failure compensation."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = (ROOT / "desktop-plugin" / "plugin.js").read_text(encoding="utf-8")


def test_starter_pack_install_tracks_only_new_profiles_for_compensation():
    assert "const createdProfiles = []" in PLUGIN
    assert "createdProfiles.push(action.name)" in PLUGIN
    assert "profiles.delete" in PLUGIN
    assert "createdProfiles.slice().reverse()" in PLUGIN


def test_starter_pack_install_reports_rollback_failures_explicitly():
    assert "rollbackFailures" in PLUGIN
    assert "rollback incomplete" in PLUGIN
    assert "profiles.list" in PLUGIN
