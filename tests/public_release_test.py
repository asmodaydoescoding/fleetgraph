#!/usr/bin/env python3
"""Deterministic public-release audit for Fleet Graph staging trees.

Exact private identifiers are supplied at runtime and remain outside Git. Audit
output intentionally reports only private labels, repository-relative paths,
line numbers, and generic detector IDs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Sequence

EXPECTED_VERSION = "0.7.0"
ALLOWLIST_PATH = "release/allowlist.txt"
SELF_PATH = "tests/public_release_test.py"
TEXT_SUFFIXES = {
    ".py",
    ".js",
    ".mjs",
    ".json",
    ".yaml",
    ".yml",
    ".md",
    ".txt",
    ".lock",
    ".toml",
    ".sh",
    ".html",
    ".css",
    ".svg",
}
CATEGORIES = (
    "allowlist_closure",
    "credential",
    "developer_test_path",
    "external_symlink",
    "forbidden_artifact",
    "private_identifier",
    "topology_state",
    "version_mismatch",
)
DETAIL_LIMIT_PER_CATEGORY = 30


class AuditInputError(ValueError):
    """Raised for invalid CLI inputs without echoing sensitive values."""


@dataclass(frozen=True, order=True)
class Finding:
    category: str
    path: str
    line: int
    detector: str


@dataclass(frozen=True)
class PrivateIdentifier:
    label: str
    value: str
    folded: str


@dataclass(frozen=True, order=True)
class Exemption:
    detector: str
    path: str
    line: int


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit a Fleet Graph release tree")
    parser.add_argument("--root", required=True, help="release staging root")
    parser.add_argument(
        "--private-denylist",
        required=True,
        help="external labeled private-identifier file",
    )
    parser.add_argument(
        "--exemptions",
        default=None,
        help="optional UTF-8 TSV exemptions file: detector<TAB>repo-rel-path<TAB>line",
    )
    return parser.parse_args(argv)


def resolve_root(raw: str) -> Path:
    root = Path(raw).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise AuditInputError("release root is not a directory")
    return root


def load_private_identifiers(path: Path) -> tuple[PrivateIdentifier, ...]:
    if path.is_symlink() or not path.is_file():
        raise AuditInputError("private denylist is not a regular file")
    rows = path.read_text(encoding="utf-8", errors="strict").splitlines()
    row_re = re.compile(r"^(private-[0-9]{4})\t(.+)$")
    parsed: list[PrivateIdentifier] = []
    labels: set[str] = set()
    values: set[str] = set()
    for row in rows:
        match = row_re.fullmatch(row)
        if not match:
            raise AuditInputError("private denylist has an invalid row")
        label, value = match.groups()
        folded = value.casefold()
        if label in labels or folded in values:
            raise AuditInputError("private denylist contains a duplicate")
        labels.add(label)
        values.add(folded)
        parsed.append(PrivateIdentifier(label, value, folded))
    if not parsed:
        raise AuditInputError("private denylist is empty")
    return tuple(parsed)


def load_exemptions(path: Path | None) -> tuple[Exemption, ...]:
    """Parse an optional UTF-8 TSV exemptions file.

    Rows are detector<TAB>repo-relative-path<TAB>line. Blank lines and
    #-comments are skipped; a malformed row or an unreadable file raises
    AuditInputError so main() exits with status 2 (fail-closed).
    """
    if path is None:
        return ()
    if path.is_symlink() or not path.is_file():
        raise AuditInputError("exemptions file is not a regular file")
    rows = path.read_text(encoding="utf-8", errors="strict").splitlines()
    parsed: list[Exemption] = []
    for row in rows:
        stripped = row.strip()
        if not stripped or stripped.startswith("#"):
            continue
        fields = row.split("\t")
        if len(fields) != 3:
            raise AuditInputError("exemptions file has an invalid row")
        detector, exempt_path, raw_line = (field.strip() for field in fields)
        if not detector or not exempt_path:
            raise AuditInputError("exemptions file has an invalid row")
        try:
            line = int(raw_line)
        except ValueError:
            raise AuditInputError("exemptions file has an invalid row") from None
        if line < 0:
            raise AuditInputError("exemptions file has an invalid row")
        parsed.append(Exemption(detector, exempt_path, line))
    return tuple(parsed)


def relpath(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def walk_entries(root: Path) -> tuple[list[Path], list[Path]]:
    """Return sorted files and directories without following symlink dirs."""
    files: list[Path] = []
    directories: list[Path] = []
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        dirnames.sort()
        filenames.sort()
        kept: list[str] = []
        for name in dirnames:
            candidate = current_path / name
            directories.append(candidate)
            if not candidate.is_symlink():
                kept.append(name)
        dirnames[:] = kept
        files.extend(current_path / name for name in filenames)
    return sorted(files, key=lambda p: relpath(root, p)), sorted(
        directories, key=lambda p: relpath(root, p)
    )


def add(
    findings: set[Finding], category: str, path: str, line: int, detector: str
) -> None:
    findings.add(Finding(category, path, line, detector))


def is_within(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def scan_symlinks(
    root: Path,
    entries: Iterable[Path],
    findings: set[Finding],
) -> None:
    for path in entries:
        if not path.is_symlink():
            continue
        try:
            target = path.resolve(strict=False)
        except OSError:
            target = path.parent.resolve(strict=False) / "unresolved"
        if not is_within(root, target):
            add(findings, "external_symlink", relpath(root, path), 0, "outside-root")


def forbidden_artifact_detector(relative: str, is_directory: bool) -> str | None:
    parts = PurePosixPath(relative).parts
    lowered = tuple(part.casefold() for part in parts)
    basename = lowered[-1] if lowered else ""
    cache_names = {"__pycache__", "node_modules", ".pytest_cache", ".mypy_cache"}
    if any(part in cache_names for part in lowered):
        return "cache-directory"
    if basename == ".coverage" or basename.startswith("coverage."):
        return "coverage-output"
    if not is_directory:
        if basename == ".env" or basename.startswith(".env."):
            return "environment-file"
        if basename.endswith((".db", ".jsonl", ".log", ".bak", ".pyc")):
            return "forbidden-extension"
        if basename.endswith((".sqlite", ".sqlite3")) or ".sqlite." in basename:
            return "sqlite-file"
    return None


def scan_path_policy(
    root: Path,
    files: Iterable[Path],
    directories: Iterable[Path],
    private: Sequence[PrivateIdentifier],
    findings: set[Finding],
) -> None:
    for path, is_directory in [
        *((item, False) for item in files),
        *((item, True) for item in directories),
    ]:
        relative = relpath(root, path)
        detector = forbidden_artifact_detector(relative, is_directory)
        if detector:
            add(findings, "forbidden_artifact", relative, 0, detector)
        folded_path = relative.casefold()
        for identifier in private:
            if identifier.folded in folded_path:
                add(
                    findings,
                    "private_identifier",
                    relative,
                    0,
                    identifier.label,
                )
        if not is_directory and PurePosixPath(relative).name.casefold() in {
            "fleet_graph.yaml",
            "fleet_graph.yml",
        }:
            if relative != "examples/fleet_graph.example.yaml":
                add(findings, "topology_state", relative, 0, "runtime-topology")


def compile_path_patterns() -> tuple[tuple[str, re.Pattern[str]], ...]:
    slash = "/"
    unix_home = slash + "home" + slash
    mac_home = slash + "Users" + slash
    data_root = slash + "data" + slash
    mount_root = slash + "mnt" + slash
    return (
        ("unix-home", re.compile(re.escape(unix_home) + r"[^/\s\"']+")),
        ("macos-home", re.compile(re.escape(mac_home) + r"[^/\s\"']+")),
        ("data-root", re.compile(re.escape(data_root) + r"[^\s\"']+")),
        ("mount-root", re.compile(re.escape(mount_root) + r"[^\s\"']+")),
        (
            "windows-home",
            re.compile(
                r"(?i)\b[A-Z]:[\\/](?:Users|Documents[ ]and[ ]Settings)[\\/]"
                r"[^\\/\s\"']+"
            ),
        ),
    )


def compile_credential_patterns() -> tuple[tuple[str, re.Pattern[str]], ...]:
    aws_prefix = "A" + "K" + "I" + "A"
    github_prefixes = tuple(
        left + right
        for left, right in (("gh", "p_"), ("gh", "o_"), ("gh", "u_"), ("gh", "s_"), ("github_pat", "_"))
    )
    openai_prefix = "s" + "k" + "-"
    pem_begin = "-" * 5 + "BEGIN "
    pem_end = " PRIVATE KEY" + "-" * 5
    bearer_word = "Bear" + "er"
    return (
        ("aws-access-key", re.compile(r"\b" + re.escape(aws_prefix) + r"[0-9A-Z]{16}\b")),
        (
            "github-token",
            re.compile(
                r"\b(?:"
                + "|".join(re.escape(prefix) for prefix in github_prefixes)
                + r")[A-Za-z0-9_]{20,255}\b"
            ),
        ),
        (
            "openai-style-key",
            re.compile(r"\b" + re.escape(openai_prefix) + r"[A-Za-z0-9_-]{20,}\b"),
        ),
        (
            "private-key-header",
            re.compile(
                re.escape(pem_begin)
                + r"(?:RSA |EC |OPENSSH |DSA |PGP )?"
                + re.escape(pem_end)
            ),
        ),
        (
            "bearer-value",
            re.compile(
                r"(?i)\b"
                + re.escape(bearer_word)
                + r"\s+[A-Za-z0-9._~+/=-]{20,}"
            ),
        ),
    )


def assignment_pattern() -> re.Pattern[str]:
    key_words = (
        "to" + "ken",
        "sec" + "ret",
        "pass" + "word",
        "api" + "_key",
        "access" + "_key",
    )
    return re.compile(
        r"(?i)\b(?:"
        + "|".join(re.escape(word) for word in key_words)
        + r")\b\s*[:=]\s*[\"']?([^\s\"',;}{]{12,})"
    )


def is_placeholder(value: str) -> bool:
    folded = value.casefold()
    hints = (
        "placeholder",
        "example",
        "redacted",
        "your_",
        "your-",
        "dummy",
        "fake",
        "sample",
        "changeme",
        "replace",
        "xxxxx",
        "test",
        "none",
        "null",
        "${",
        "{{",
        "<",
    )
    return any(hint in folded for hint in hints) or len(set(folded)) <= 3


def scan_text_file(
    root: Path,
    path: Path,
    private: Sequence[PrivateIdentifier],
    findings: set[Finding],
) -> None:
    relative = relpath(root, path)
    if path.suffix.casefold() not in TEXT_SUFFIXES:
        return
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        add(findings, "forbidden_artifact", relative, 0, "unreadable-text")
        return

    path_patterns = compile_path_patterns()
    credential_patterns = compile_credential_patterns()
    assignment = assignment_pattern()
    slash = "/"
    fixed_test_temp = slash + "tmp" + slash + "plugin" + "-load-test"
    hermes_fragment = "." + "hermes"
    tests_file = relative.startswith("tests/")

    for line_number, line in enumerate(text.splitlines(), 1):
        folded = line.casefold()
        for identifier in private:
            if identifier.folded in folded:
                add(
                    findings,
                    "private_identifier",
                    relative,
                    line_number,
                    identifier.label,
                )
        for detector, pattern in path_patterns:
            if pattern.search(line):
                add(findings, "developer_test_path", relative, line_number, detector)
        if tests_file and fixed_test_temp in line:
            add(
                findings,
                "developer_test_path",
                relative,
                line_number,
                "fixed-test-temp",
            )
        if tests_file and hermes_fragment in line:
            if re.search(r"Path\s*\.\s*home\s*\(\s*\)", line):
                add(
                    findings,
                    "developer_test_path",
                    relative,
                    line_number,
                    "live-home-coupling",
                )
        for detector, pattern in credential_patterns:
            if pattern.search(line):
                add(findings, "credential", relative, line_number, detector)
        assignment_match = assignment.search(line)
        if assignment_match and not is_placeholder(assignment_match.group(1)):
            add(
                findings,
                "credential",
                relative,
                line_number,
                "sensitive-assignment",
            )


def read_text(root: Path, relative: str) -> tuple[str | None, int]:
    path = root / relative
    if path.is_symlink() or not path.is_file():
        return None, 0
    text = path.read_text(encoding="utf-8", errors="replace")
    return text, max(1, text.count("\n") + 1)


def scan_versions(root: Path, findings: set[Finding]) -> None:
    plugin_text, _ = read_text(root, "plugin.yaml")
    if plugin_text is None:
        add(findings, "version_mismatch", "plugin.yaml", 0, "missing-file")
    else:
        match = re.search(r"(?m)^\s*version:\s*[\"']?([^\s\"']+)", plugin_text)
        if not match or match.group(1) != EXPECTED_VERSION:
            line = plugin_text[: match.start()].count("\n") + 1 if match else 0
            add(findings, "version_mismatch", "plugin.yaml", line, "expected-v0.7.0")

    frontend_text, _ = read_text(root, "desktop-plugin/plugin.js")
    version_literal = re.compile(r"\b[vV]" + re.escape(EXPECTED_VERSION) + r"\b")
    if frontend_text is None or not version_literal.search(frontend_text):
        add(
            findings,
            "version_mismatch",
            "desktop-plugin/plugin.js",
            0,
            "expected-display-v0.7.0",
        )

    readme_text, _ = read_text(root, "README.md")
    if readme_text is None or not re.search(
        r"(?i)\bv" + re.escape(EXPECTED_VERSION) + r"\b", readme_text
    ):
        add(
            findings,
            "version_mismatch",
            "README.md",
            0,
            "expected-release-v0.7.0",
        )

    manifest_text, _ = read_text(root, "dashboard/manifest.json")
    if manifest_text is None:
        add(
            findings,
            "version_mismatch",
            "dashboard/manifest.json",
            0,
            "missing-file",
        )
    else:
        try:
            manifest = json.loads(manifest_text)
        except json.JSONDecodeError:
            manifest = None
        if not isinstance(manifest, dict) or manifest.get("version") != EXPECTED_VERSION:
            add(
                findings,
                "version_mismatch",
                "dashboard/manifest.json",
                0,
                "expected-v0.7.0",
            )


def normalize_allowlist_entry(raw: str) -> str | None:
    entry = raw.strip()
    if not entry:
        return None
    path = PurePosixPath(entry)
    if path.is_absolute() or ".." in path.parts or entry != path.as_posix():
        return ""
    return entry


def scan_allowlist(
    root: Path,
    files: Sequence[Path],
    findings: set[Finding],
) -> None:
    allowlist = root / ALLOWLIST_PATH
    if allowlist.is_symlink() or not allowlist.is_file():
        add(findings, "allowlist_closure", ALLOWLIST_PATH, 0, "missing-control-file")
        return
    listed: list[str] = []
    for line_number, raw in enumerate(
        allowlist.read_text(encoding="utf-8", errors="replace").splitlines(), 1
    ):
        normalized = normalize_allowlist_entry(raw)
        if normalized is None:
            continue
        if normalized == "":
            add(
                findings,
                "allowlist_closure",
                ALLOWLIST_PATH,
                line_number,
                "invalid-entry",
            )
            continue
        listed.append(normalized)

    counts = Counter(listed)
    for entry, count in sorted(counts.items()):
        if count > 1:
            add(findings, "allowlist_closure", entry, 0, "duplicate-entry")
        candidate = root / entry
        try:
            mode = candidate.lstat().st_mode
        except OSError:
            add(findings, "allowlist_closure", entry, 0, "listed-missing")
            continue
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
            add(findings, "allowlist_closure", entry, 0, "listed-not-regular")

    listed_set = set(listed)
    regular_files: set[str] = set()
    for path in files:
        try:
            mode = path.lstat().st_mode
        except OSError:
            continue
        if stat.S_ISREG(mode):
            relative = relpath(root, path)
            if relative != ALLOWLIST_PATH:
                regular_files.add(relative)
    for extra in sorted(regular_files - listed_set):
        add(findings, "allowlist_closure", extra, 0, "unlisted-file")
    for stale in sorted(listed_set - regular_files):
        candidate = root / stale
        if not candidate.exists() or candidate.is_symlink() or not candidate.is_file():
            continue
        add(findings, "allowlist_closure", stale, 0, "not-in-regular-inventory")


def redact_path(path: str, private: Sequence[PrivateIdentifier]) -> str:
    redacted = path
    for identifier in sorted(private, key=lambda item: len(item.value), reverse=True):
        redacted = re.sub(
            re.escape(identifier.value),
            "[REDACTED]",
            redacted,
            flags=re.IGNORECASE,
        )
    return redacted


def audit(
    root: Path,
    private: Sequence[PrivateIdentifier],
    exemptions: Sequence[Exemption] = (),
) -> list[Finding]:
    findings: set[Finding] = set()
    files, directories = walk_entries(root)
    scan_symlinks(root, [*files, *directories], findings)
    scan_path_policy(root, files, directories, private, findings)
    for path in files:
        try:
            mode = path.lstat().st_mode
        except OSError:
            continue
        if stat.S_ISREG(mode):
            scan_text_file(root, path, private, findings)
    scan_versions(root, findings)
    scan_allowlist(root, files, findings)
    if exemptions:
        exempt_keys = {(item.detector, item.path, item.line) for item in exemptions}
        findings = {
            finding
            for finding in findings
            if (finding.detector, finding.path, finding.line) not in exempt_keys
        }
    return sorted(findings)


def emit(findings: Sequence[Finding], private: Sequence[PrivateIdentifier]) -> None:
    status = "FAIL" if findings else "PASS"
    print(f"PUBLIC RELEASE AUDIT: {status}")
    grouped: dict[str, list[Finding]] = defaultdict(list)
    for finding in findings:
        grouped[finding.category].append(finding)
    for category in CATEGORIES:
        print(f"CATEGORY {category} {len(grouped.get(category, []))}")
    for category in CATEGORIES:
        category_findings = grouped.get(category, [])
        for finding in category_findings[:DETAIL_LIMIT_PER_CATEGORY]:
            safe_path = redact_path(finding.path, private)
            print(
                f"FINDING {finding.category} {safe_path}:{finding.line} "
                f"{finding.detector}"
            )
        omitted = len(category_findings) - DETAIL_LIMIT_PER_CATEGORY
        if omitted > 0:
            print(f"OMITTED {category} {omitted}")


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        root = resolve_root(args.root)
        private = load_private_identifiers(Path(args.private_denylist).expanduser())
        exemptions = load_exemptions(
            Path(args.exemptions).expanduser() if args.exemptions else None
        )
        findings = audit(root, private, exemptions)
        emit(findings, private)
        return 1 if findings else 0
    except (AuditInputError, OSError, UnicodeError):
        print("PUBLIC RELEASE AUDIT: ERROR", file=sys.stderr)
        print("invalid or unreadable audit input", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
