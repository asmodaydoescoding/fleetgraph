from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")


def test_install_docs_use_hermes_native_installer_and_pin():
    assert "hermes plugins install asmodaydoescoding/fleetgraph" in README
    assert "--ref \"$FLEET_GRAPH_REF\"" in README
    assert "--enable" in README
    assert 'FLEET_GRAPH_REF="a332add24501b733399ed1eb77b5e92d9b36d517"' in README


def test_install_docs_verify_the_real_unified_package_layout():
    for path in (
        'PLUGIN_DIR="$HERMES_HOME/plugins/fleet-graph"',
        'dashboard/manifest.json',
        'dashboard/plugin_api.py',
        'desktop-plugin/plugin.js',
        'DESKTOP_DIR="${HERMES_HOME}/desktop-plugins/fleet-graph"',
    ):
        assert path in README
    assert "Copy this folder into" not in README
    assert "Do not copy the entire" in README


def test_install_docs_separate_runtime_from_development_dependencies():
    assert "do **not** need" in README
    assert "pytest" in README
    assert "npm ci" in README
    assert "Development" in README
    assert "Remount routes" in README
    assert "systemctl --user restart hermes-dashboard.service" in README
