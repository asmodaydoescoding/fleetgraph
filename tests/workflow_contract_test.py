"""Reachability contracts for Fleet Graph's approval-gated workflows."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
PLUGIN = (ROOT / "desktop-plugin" / "plugin.js").read_text(encoding="utf-8")


def test_workflow_api_exposes_safe_advisor_and_hierarchy_surfaces():
    assert '"/workflows"' in API
    assert '"/advisor/preview"' in API
    assert '"/hierarchy/preview"' in API
    assert '"/hierarchy/apply"' in API
    assert "confirm" in API
    assert "mutates" in API
    assert "raw_transcripts" in API


def test_desktop_reaches_workflows_with_explicit_approval():
    assert "WorkflowPanel" in PLUGIN
    assert "insights.get" in PLUGIN
    assert "advisor/preview" in PLUGIN
    assert "hierarchy/preview" in PLUGIN
    assert "hierarchy/apply" in PLUGIN
    assert "Approve & apply hierarchy" in PLUGIN
    assert "No automatic profile creation" in PLUGIN
