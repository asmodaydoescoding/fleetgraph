"""Fail-closed validation for inert Fleet Graph starter packs.

The validator only reads YAML/Markdown/JSON data. It never imports, executes,
installs, or writes anything from a pack. Profile creation remains the caller's
explicit Hermes ``profiles.create`` operation.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any, Iterable, NoReturn

import yaml


class PackValidationError(ValueError):
    """Raised when a starter pack cannot be trusted as a data-only template."""


PACK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

_MANIFEST_KEYS = {
    "id", "version", "title", "description", "kind", "optional", "license",
    "files", "topology", "source_profiles", "credits", "install_mode",
    "executes_external_code", "checksum", "profiles",
}
_SOURCE_KEYS = {"name", "url", "license", "expected_profiles"}
_CHECKSUM_KEYS = {"algorithm", "file", "value"}
_PROFILE_KEYS = {"name", "clone_from", "adopt_only"}
_TOPOLOGY_KEYS = {"summary", "title", "supervisor", "subordinates", "peers"}
_SAFE_SUFFIXES = {".yaml", ".yml", ".md", ".json", ".txt"}
_EXECUTABLE_SUFFIXES = {".py", ".js", ".mjs", ".sh", ".bash", ".exe", ".so", ".dll"}


def _fail(message: str) -> NoReturn:
    raise PackValidationError(message)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be a mapping")
    return value


def _allowed(mapping: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(mapping) - allowed)
    if unknown:
        _fail(f"{label} has unsupported fields: {', '.join(unknown)}")


def _profile_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not PROFILE_NAME_RE.fullmatch(value):
        _fail(f"{label} is not a valid profile name")
    return value


def _safe_pack_file(root: Path, relative: Any, label: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        _fail(f"{label} is not a safe relative path")
    path = Path(relative)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        _fail(f"{label} is not a safe relative path")
    if path.suffix.lower() in _EXECUTABLE_SUFFIXES or path.suffix.lower() not in _SAFE_SUFFIXES:
        _fail(f"{label} is not an inert pack file")
    target = (root / path).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        _fail(f"{label} escapes the pack directory")
    if not target.is_file():
        _fail(f"{label} does not exist")
    return target


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_yaml(path: Path, label: str) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        _fail(f"{label} is malformed YAML: {exc}")


def _validate_profiles(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        _fail("profiles must be a non-empty list")
    result: list[dict[str, Any]] = []
    names: set[str] = set()
    for index, item in enumerate(raw):
        row = _mapping(item, f"profiles[{index}]")
        _allowed(row, _PROFILE_KEYS, f"profiles[{index}]")
        name = _profile_name(row.get("name"), f"profiles[{index}].name")
        if name in names:
            _fail(f"duplicate profile name: {name}")
        names.add(name)
        adopt_only = row.get("adopt_only", False)
        if not isinstance(adopt_only, bool):
            _fail(f"profiles[{index}].adopt_only must be boolean")
        clone_from = row.get("clone_from")
        if adopt_only:
            if clone_from is not None:
                _fail(f"adopt-only profile {name} cannot declare clone_from")
        else:
            _profile_name(clone_from, f"profiles[{index}].clone_from")
            if clone_from == name:
                _fail(f"profile {name} cannot clone itself")
        result.append({
            "name": name,
            "clone_from": clone_from,
            "adopt_only": adopt_only,
        })
    return result


def _validate_topology(raw: Any) -> dict[str, dict[str, Any]]:
    data = _mapping(raw, "topology")
    if not data:
        _fail("topology must not be empty")
    names: set[str] = set()
    topology: dict[str, dict[str, Any]] = {}
    for name, value in data.items():
        canonical = _profile_name(name, f"topology node {name!r}")
        if canonical in names:
            _fail(f"duplicate topology node: {canonical}")
        row = _mapping(value, f"topology.{canonical}")
        _allowed(row, _TOPOLOGY_KEYS, f"topology.{canonical}")
        for field in ("summary", "title"):
            if field in row and not isinstance(row[field], str):
                _fail(f"topology.{canonical}.{field} must be a string")
        supervisor = row.get("supervisor")
        if supervisor is not None:
            _profile_name(supervisor, f"topology.{canonical}.supervisor")
            if supervisor == canonical:
                _fail(f"topology node {canonical} supervises itself")
        for field in ("subordinates", "peers"):
            values = row.get(field)
            if values is None:
                continue
            if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
                _fail(f"topology.{canonical}.{field} must be a list of names")
            normalized = [_profile_name(item, f"topology.{canonical}.{field}") for item in values]
            if len(normalized) != len(set(normalized)):
                _fail(f"topology.{canonical}.{field} contains duplicates")
            if canonical in normalized:
                _fail(f"topology node {canonical} references itself")
            row[field] = normalized
        names.add(canonical)
        topology[canonical] = dict(row)

    for name, row in topology.items():
        supervisor = row.get("supervisor")
        if supervisor is not None and supervisor not in names:
            _fail(f"topology.{name} references unknown supervisor: {supervisor}")
    for start in topology:
        seen: set[str] = set()
        current: str | None = start
        while current is not None:
            if current in seen:
                _fail(f"topology contains a supervisor cycle at {current}")
            seen.add(current)
            current = topology[current].get("supervisor")
    return topology


def load_pack(root: str | Path, available_profiles: Iterable[str] | None = None) -> dict[str, Any]:
    """Read and validate one inert pack, returning a normalized preview object."""
    pack_root = Path(root).expanduser().resolve()
    if not pack_root.is_dir():
        _fail("pack directory does not exist")
    manifest_path = _safe_pack_file(pack_root, "pack.yaml", "pack.yaml")
    manifest = _mapping(_read_yaml(manifest_path, "pack.yaml"), "pack.yaml")
    _allowed(manifest, _MANIFEST_KEYS, "pack.yaml")

    pack_id = manifest.get("id")
    if not isinstance(pack_id, str) or not PACK_ID_RE.fullmatch(pack_id):
        _fail("pack.yaml.id is invalid")
    if pack_id != pack_root.name:
        _fail("pack.yaml.id must match the pack directory name")
    if not isinstance(manifest.get("version"), str) or not manifest["version"].strip():
        _fail("pack.yaml.version is required")
    for field in ("title", "description", "kind", "license", "install_mode"):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            _fail(f"pack.yaml.{field} is required")
    if manifest["kind"] != "topology" or manifest["install_mode"] != "preview_then_apply":
        _fail("pack must be a topology with preview_then_apply install mode")
    if manifest.get("optional") is not True or manifest.get("executes_external_code") is not False:
        _fail("pack must be optional and data-only")

    files_raw = manifest.get("files")
    if (
        not isinstance(files_raw, list)
        or any(not isinstance(item, str) for item in files_raw)
        or len(files_raw) != len(set(files_raw))
    ):
        _fail("pack.yaml.files must be a duplicate-free list of paths")
    files: list[str] = files_raw
    file_paths = {
        item: _safe_pack_file(pack_root, item, f"files[{index}]")
        for index, item in enumerate(files)
    }
    topology_name = manifest.get("topology")
    if not isinstance(topology_name, str):
        _fail("pack.yaml.topology must name a file")
    topology_path = _safe_pack_file(pack_root, topology_name, "topology")
    if topology_name not in file_paths:
        _fail("topology must be listed in pack.yaml.files")

    source = _mapping(manifest.get("source_profiles"), "source_profiles")
    _allowed(source, _SOURCE_KEYS, "source_profiles")
    if not isinstance(source.get("url"), str) or not source["url"].startswith(("https://", "http://")):
        _fail("source_profiles.url must be an absolute web URL")
    if source.get("license") != manifest["license"]:
        _fail("source_profiles.license must match pack.yaml.license")

    checksum = _mapping(manifest.get("checksum"), "checksum")
    _allowed(checksum, _CHECKSUM_KEYS, "checksum")
    if checksum.get("algorithm") != "sha256" or not isinstance(checksum.get("file"), str):
        _fail("checksum must use sha256 and name a file")
    checksum_path = _safe_pack_file(pack_root, checksum["file"], "checksum.file")
    if checksum["file"] not in file_paths:
        _fail("checksum.file must be listed in pack.yaml.files")
    expected = checksum.get("value")
    if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected) or _sha256(checksum_path) != expected:
        _fail("pack checksum mismatch")

    profiles = _validate_profiles(manifest.get("profiles"))
    topology = _validate_topology(_read_yaml(topology_path, topology_name))
    profile_names = {row["name"] for row in profiles}
    if profile_names != set(topology):
        _fail("profiles and topology must contain exactly the same names")

    available = set(available_profiles or {"default"})
    for row in profiles:
        clone_from = row["clone_from"]
        if not row["adopt_only"] and clone_from not in available:
            _fail(f"profile {row['name']} has unknown clone source: {clone_from}")

    return {
        "root": str(pack_root),
        "id": pack_id,
        "version": manifest["version"],
        "title": manifest["title"],
        "description": manifest["description"],
        "license": manifest["license"],
        "source_profiles": source,
        "credits": manifest.get("credits") or {},
        "profiles": profiles,
        "topology": topology,
        "checksum": {"algorithm": "sha256", "file": checksum["file"], "value": expected},
    }


def selected_actions(pack: dict[str, Any], selected: Iterable[str], available_profiles: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """Return explicit adopt/create actions for a user-approved selection."""
    names = list(selected)
    if len(names) != len(set(names)):
        _fail("selected profile names contain duplicates")
    rows = {row["name"]: row for row in pack.get("profiles", [])}
    available = set(available_profiles or {"default"})
    actions: list[dict[str, Any]] = []
    for name in names:
        _profile_name(name, "selected profile")
        if name not in rows:
            _fail(f"selected profile is not in pack: {name}")
        row = rows[name]
        if name in available:
            actions.append({"name": name, "action": "adopt", "clone_from": None})
        elif row["adopt_only"]:
            _fail(f"adopt-only profile is not installed: {name}")
        else:
            source = row["clone_from"]
            if source not in available:
                _fail(f"profile {name} has unknown clone source: {source}")
            actions.append({"name": name, "action": "create", "clone_from": source})
    return actions
