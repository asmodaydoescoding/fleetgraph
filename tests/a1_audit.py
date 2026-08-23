#!/usr/bin/env python3
"""Static audit: acorn parse + loader-regex count + token/key scan."""
import os
import re
import subprocess
import sys
from pathlib import Path

PLUGIN = os.environ.get(
    "FLEET_PLUGIN_JS",
    str(Path(__file__).resolve().parents[1] / "desktop-plugin" / "plugin.js"),
)
HARNESS_DIR = Path(
    os.environ.get("FLEET_HARNESS_DIR", Path(__file__).resolve().parent)
)
ACORN = HARNESS_DIR / "node_modules" / "acorn" / "dist" / "acorn.mjs"
src = open(PLUGIN).read()
node = subprocess.run(["node", "-e", """
const { pathToFileURL } = require('node:url');
import(pathToFileURL(process.argv[1]).href).then(async acorn => {
  const fs = await import('node:fs');
  try { acorn.parse(fs.readFileSync(process.argv[2],'utf8'), { ecmaVersion:'latest', sourceType:'module' }); console.log('PARSE OK'); }
  catch (e) { console.error('PARSE FAIL', e.loc && e.loc.line, e.message); process.exit(1); }
}).catch(e => { console.error('ACORN LOAD FAIL', e.message); process.exit(1); });
""", str(ACORN), PLUGIN], capture_output=True, text=True)
print(node.stdout.strip() or node.stderr.strip())
ok = node.returncode == 0 and "PARSE OK" in node.stdout
loader = re.findall(r"(from\s*|import\s*\(\s*|import\s+)(['\"])([^'\"]+)\2", src)
print("loader imports:", len(loader))
ok = ok and len(loader) == 3
bad = 0
for i, l in enumerate(src.split("\n"), 1):
    if re.search(r"jsx?s?\(\s*'[^']*',\s*\{[^}]*\bkey:", l): bad += 1; print(f"  key-in-props line {i}")
print("token/key findings:", bad)
ok = ok and bad == 0
css_classes = sorted(set(re.findall(r"\.(fleet-[a-z0-9-]+)", src)))
dead_classes = [name for name in css_classes
                if len(re.findall(rf"(?<![a-z0-9-]){re.escape(name)}(?![a-z0-9-])", src)) < 2]
print("unwired fleet CSS classes:", dead_classes)
ok = ok and not dead_classes
sys.exit(0 if ok else 1)
