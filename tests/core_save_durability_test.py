#!/usr/bin/env python3
"""Core save durability: share-aware reads + rename retries + concurrency.

Regression coverage for the Windows concurrent-save failure (issue #2
re-test): readers must never block the atomic replacement rename, the save
path must ride out transient rename collisions inside a bounded window, and
it must stay fail-loud (no silent partial state) when the rename never
lands. Runs on plain python3 + pyyaml; no FastAPI needed.
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import threading
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"[PASS] {name}")
    else:
        failed += 1
        print(f"[FAIL] {name}" + (f" — {detail}" if detail else ""))


class _FakeCreateFile:
    """Callable stand-in for kernel32.CreateFileW that accepts the
    restype/argtypes attributes the real opener sets, and records calls."""

    def __init__(self, calls: list, handle: int):
        self._calls = calls
        self._handle = handle

    def __call__(self, name, access, share, sec, disp, flags, templ):
        self._calls.append({"name": name, "access": access, "share": share,
                            "disposition": disp})
        return self._handle


class _FakeKernel32:
    def __init__(self, handle: int = 1):
        self.calls: list[dict] = []
        self.closed: list = []
        self.CreateFileW = _FakeCreateFile(self.calls, handle)

    def CloseHandle(self, handle):
        self.closed.append(handle)


class _FakeMsvcrt:
    def __init__(self, path: Path, fail: bool = False):
        self.path = path
        self.fail = fail

    def open_osfhandle(self, handle, flags):
        if self.fail:
            raise OSError(9, "Bad file descriptor (simulated)")
        return os.open(str(self.path), os.O_RDONLY)


with tempfile.TemporaryDirectory(prefix="fleet-core-durability-") as td:
    home = Path(td) / ".hermes"
    home.mkdir()
    graph_path = home / "fleet_graph.yaml"
    graph_path.write_text("captain: {subordinates: [worker-x]}\n"
                          "worker-x: {supervisor: captain}\n")
    os.environ.update({
        "FLEET_HOME": str(home),
        "FLEET_GRAPH_PATH": str(graph_path),
    })
    sys.path.insert(0, str(PLUGIN_DIR))
    sys.modules.pop("fleet_graph_core", None)
    core = importlib.import_module("fleet_graph_core")

    # 1. Every topology read goes through the share-aware opener — the fixed
    #    property that stops readers from blocking the save rename.
    seen: list[str] = []
    orig_open_read = core._open_read

    def spy_open_read(path):
        seen.append(str(path))
        return orig_open_read(path)

    core._open_read = spy_open_read
    try:
        core.load_graph()
    finally:
        core._open_read = orig_open_read
    check("load path goes through the share-aware opener",
          seen == [str(core.GRAPH_PATH)], f"seen={seen}")

    # 2. The opener still reads the document contract on this platform.
    with core._open_read(core.GRAPH_PATH) as f:
        raw = f.read()
    check("share-aware opener serves the topology bytes",
          "captain" in raw and "worker-x" in raw)

    # 3. The Windows constants are the documented Win32 ABI values and the
    #    share mode includes the delete bit (what makes renames land).
    constants_ok = (
        core._GENERIC_READ == 0x80000000
        and core._FILE_SHARE_READ == 0x1
        and core._FILE_SHARE_WRITE == 0x2
        and core._FILE_SHARE_DELETE == 0x4
        and core._OPEN_EXISTING == 0x3
        and core._FILE_ATTRIBUTE_NORMAL == 0x80
    )
    flags = core._windows_share_flags()
    check("windows share mode is read+write+delete",
          constants_ok and flags == 0x7 and (flags & core._FILE_SHARE_DELETE),
          f"constants_ok={constants_ok} flags={flags:#x}")

    # 4. Injected Windows open path: CreateFileW is asked for a delete-shared
    #    read handle, and the returned stream reads the real content.
    fixture = home / "fixture.yaml"
    fixture.write_text("probe: value\n")
    fake_kernel32 = _FakeKernel32()
    fake_msvcrt = _FakeMsvcrt(fixture)
    got = core._open_read_windows(fixture, _api=(fake_kernel32, fake_msvcrt))
    call = fake_kernel32.calls[0] if fake_kernel32.calls else {}
    read_ok = got is not None and got.read().strip() == "probe: value"
    if got is not None:
        got.close()
    check("windows opener requests a delete-shared read handle",
          read_ok
          and call.get("access") == core._GENERIC_READ
          and call.get("share") == core._windows_share_flags()
          and call.get("disposition") == core._OPEN_EXISTING,
          f"call={call} read_ok={read_ok}")

    # 5. When the handle cannot be wrapped into an fd, the opener closes the
    #    raw handle and degrades to None (plain-open fallback upstream).
    fk = _FakeKernel32(handle=7)
    fm = _FakeMsvcrt(fixture, fail=True)
    result = core._open_read_windows(fixture, _api=(fk, fm))
    check("unwrappable handle falls back and closes the raw handle",
          result is None and fk.closed == [7],
          f"result={result} closed={fk.closed}")

    # 6. A save rides out transient rename collisions (simulated WinError 5)
    #    inside the bounded retry window and lands the document.
    orig_delays = core._REPLACE_RETRY_DELAYS
    orig_replace = core.os.replace
    core._REPLACE_RETRY_DELAYS = (0.0, 0.0, 0.0)
    try:
        state = {"n": 0}

        def flaky_replace(src, dst):
            state["n"] += 1
            if state["n"] <= 2:
                raise PermissionError(13, "Access is denied (simulated)")
            return orig_replace(src, dst)

        core.os.replace = flaky_replace
        core.save_graph({"captain": {"subordinates": ["worker-y"]},
                         "worker-y": {"supervisor": "captain"}}, relations={})
    finally:
        core.os.replace = orig_replace
        try:
            reloaded = core.load_graph()
        except Exception as exc:  # pragma: no cover - defensive
            reloaded = {"error": str(exc)}
    check("save retries transient rename collisions",
          state["n"] == 3 and set(reloaded) == {"captain", "worker-y"},
          f"attempts={state['n']} nodes={sorted(reloaded)}")

    # 7. Bounded + fail-loud: when the rename never lands, the save raises,
    #    burns exactly the configured attempts, leaves no temp file, and the
    #    previous document is intact.
    before = graph_path.read_bytes()
    attempts = {"n": 0}

    def always_fail(src, dst):
        attempts["n"] += 1
        raise PermissionError(13, "Access is denied (simulated)")

    raised = None
    core.os.replace = always_fail
    try:
        core.save_graph({"captain": {"subordinates": ["worker-z"]},
                         "worker-z": {"supervisor": "captain"}}, relations={})
    except OSError as exc:
        raised = exc
    finally:
        core.os.replace = orig_replace
        core._REPLACE_RETRY_DELAYS = orig_delays
    residue = [p.name for p in home.iterdir()
               if p.name.startswith(f".{graph_path.name}.") and p.suffix == ".tmp"]
    check("failed rename stays bounded, fail-loud, and cleans its temp file",
          raised is not None
          and attempts["n"] == 3
          and residue == []
          and graph_path.read_bytes() == before,
          f"raised={raised!r} attempts={attempts['n']} residue={residue}")

    # 8. Readers run concurrently with a saver; no read may fail or observe a
    #    broken document. (On POSIX this proves the shared save path keeps
    #    whole-document replacement; on Windows the share-delete handle keeps
    #    the same test green under rename contention.)
    variant_a = {"captain": {"subordinates": ["worker-a"]},
                 "worker-a": {"supervisor": "captain"}}
    variant_b = {"captain": {"subordinates": ["worker-a", "worker-b"]},
                 "worker-a": {"supervisor": "captain"},
                 "worker-b": {"supervisor": "captain"}}
    valid_shapes = ({"captain", "worker-a"}, {"captain", "worker-a", "worker-b"})
    core.save_graph(variant_a, relations={})  # seed a valid starting shape
    errors: list[str] = []

    def saver():
        for i in range(12):
            try:
                core.save_graph(variant_a if i % 2 == 0 else variant_b, relations={})
            except Exception as exc:
                errors.append(f"saver:{exc}")

    def reader():
        for _ in range(25):
            try:
                shape = set(core.load_graph())
                if shape not in valid_shapes:
                    errors.append(f"reader-shape:{sorted(shape)}")
            except Exception as exc:
                errors.append(f"reader:{exc}")

    threads = [threading.Thread(target=saver), threading.Thread(target=reader),
               threading.Thread(target=reader)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    check("concurrent readers and saver stay clean", not errors,
          "; ".join(errors[:4]))

    # 9. Two concurrent savers both complete; the file parses to one of the
    #    two submitted states (whole-document replacement, no interleave).
    concurrent_errors: list[str] = []

    def one_save(graph):
        try:
            core.save_graph(graph, relations={})
        except Exception as exc:
            concurrent_errors.append(str(exc))

    t1 = threading.Thread(target=one_save, args=(variant_a,))
    t2 = threading.Thread(target=one_save, args=(variant_b,))
    t1.start(); t2.start(); t1.join(timeout=30); t2.join(timeout=30)
    final_shape = set(core.load_graph())
    check("simultaneous savers replace whole documents",
          not concurrent_errors and final_shape in valid_shapes,
          f"errors={concurrent_errors[:2]} final={sorted(final_shape)}")

    # 10. The retry schedule stays bounded (guards against accidental
    #     unbounded waiting in the save path).
    total_delay = sum(core._REPLACE_RETRY_DELAYS)
    check("retry schedule is bounded",
          0 < len(core._REPLACE_RETRY_DELAYS) and total_delay <= 10.0,
          f"delays={core._REPLACE_RETRY_DELAYS}")

print(f"\nCORE SAVE DURABILITY SUMMARY: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
