# Running the harnesses and audits

Everything below is repository-relative. Run commands from this `tests/`
folder unless noted otherwise. Private identifier lists always live outside
this repository and outside version control.

## One-time setup

    cd tests
    npm ci

Installs the Node dependencies (acorn, react, react-test-renderer) into
`tests/node_modules`. The Node harnesses resolve their modules relative to
this folder, and `a1_audit.py` uses this local acorn install for its parse
step. If React reports "Invalid hook call", you ran a harness from another
directory — go back to `tests/`.

## Node harnesses

Each npm script drives one harness file in this folder:

    npm run drive      # drive-harness.mjs
    npm run hostile    # hostile-harness.mjs
    npm run loop2      # loop2-harness.mjs
    npm run loop5      # loop5-harness.mjs
    npm run tree       # loop6-harness.mjs
    npm run composer   # loop7-harness.mjs
    npm run loop8      # loop8-harness.mjs
    npm run render     # render-harness.mjs
    npm run boundary   # boundary-harness.mjs
    npm run create     # c4-create-probe.mjs

## Python audits

Static plugin audit (defaults are repo-relative):

    python3 a1_audit.py

By default it audits `<repo>/desktop-plugin/plugin.js` and looks for acorn
under this folder. Overrides, rarely needed:

    FLEET_PLUGIN_JS=/path/to/plugin.js python3 a1_audit.py
    FLEET_HARNESS_DIR=/path/to/folder-with-node_modules python3 a1_audit.py

Configurability gate (reads only repository files; the backend API section
additionally needs `fastapi` and auto-skips without it):

    python3 configurability_test.py

Two optional inputs extend it:

    FLEET_ABSENCE_MAP=/path/to/absence-map.json python3 configurability_test.py

`FLEET_ABSENCE_MAP` points to a JSON file shaped
`{"core_seed_names": [...], "operator_names": [...]}` listing the private
identifiers that must stay absent from shipped runtime files. When unset,
generic placeholders are used and the summary reports `map=default-generic`;
when set it reports `map=external`. Loaded values are never printed.

    FLEET_HOST_STYLES=/path/to/host/styles.css python3 configurability_test.py

When set, enables the host-theme token parity cross-check against the desktop
app stylesheet. When unset, the run prints
`[SKIP] host style token parity (FLEET_HOST_STYLES unset)` and counts it as
neither pass nor fail.

Backend loop8 regression (needs `fastapi`; auto-skips with a summary line and
exit 0 when it is not installed):

    python3 backend_loop8_test.py

Hermetic public integration suite (pure standard library plus repository code,
no network, no installed dependencies beyond `pyyaml`):

    python3 public_integration_test.py

## Public release audit

Run from `tests/`, auditing the release root one level up:

    python3 public_release_test.py --root .. --private-denylist /secure/outside-repo/private-identifiers.txt

Optional exemptions file (also kept outside the repository):

    python3 public_release_test.py --root .. --private-denylist /secure/outside-repo/private-identifiers.txt --exemptions /secure/outside-repo/exemptions.txt

The denylist and exemptions paths above are placeholders — point them at your
own secure locations outside this repository.
