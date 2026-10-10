"""Tests for the ach console-script wrapper.

The execv path is exercised in a subprocess so the test process itself is
never replaced; exit-code and argv passthrough are asserted against a fake
runtime forced via AGENTIC_CODING_HARNESS_RUNTIME.
"""

import os
import subprocess
import sys

from agentic_coding_harness import _cli


def _run_cli(tmp_path, fake_body, args):
    fake = tmp_path / "fake-runtime"
    seen = tmp_path / "argv"
    body = fake_body.replace("{seen}", str(seen))
    fake.write_text("#!/bin/sh\n" + body)
    fake.chmod(0o755)
    env = dict(os.environ, AGENTIC_CODING_HARNESS_RUNTIME=str(fake))
    return (
        subprocess.run(
            [sys.executable, "-m", "agentic_coding_harness._cli", *args],
            env=env,
            capture_output=True,
            text=True,
        ),
        seen,
    )


def test_help_exits_zero_with_fake_runtime(tmp_path):
    proc, seen = _run_cli(
        tmp_path,
        'printf "%s\\n" "$@" > "{seen}"\nexit 0\n',
        ["--help"],
    )
    assert proc.returncode == 0
    argv = seen.read_text().splitlines()
    assert argv[0].endswith("_vendor/ach.mjs")
    assert "--help" in argv


def test_exit_code_passthrough(tmp_path):
    proc, _ = _run_cli(tmp_path, "exit 42\n", ["run", "agent"])
    assert proc.returncode == 42


def test_missing_runtime_exits_127(monkeypatch, capsys):
    monkeypatch.setattr(_cli, "find_runtime", lambda: None)
    assert _cli.main(["--help"]) == 127
    assert "no JavaScript runtime" in capsys.readouterr().err


def test_find_runtime_rejects_bogus_override():
    assert _cli.find_runtime({"AGENTIC_CODING_HARNESS_RUNTIME": "/no/such/binary"}) is None


def test_find_runtime_accepts_override(tmp_path):
    fake = tmp_path / "runtime"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(0o755)
    env = {"AGENTIC_CODING_HARNESS_RUNTIME": str(fake)}
    assert _cli.find_runtime(env) == str(fake)


def _fake_node(directory, version):
    directory.mkdir(parents=True, exist_ok=True)
    fake = directory / "node"
    fake.write_text('#!/bin/sh\necho "v{}"\n'.format(version))
    fake.chmod(0o755)
    return fake


def _isolate_runtime_search(monkeypatch, bin_dir):
    # Only the fake dir is searched: no real bun/node via PATH or install dirs.
    monkeypatch.setenv("PATH", str(bin_dir))
    monkeypatch.setattr(_cli, "_COMMON_DIRS", ())


def test_find_runtime_rejects_node_below_floor(tmp_path, monkeypatch):
    _fake_node(tmp_path / "bin", "20.11.0")
    _isolate_runtime_search(monkeypatch, tmp_path / "bin")
    assert _cli.find_runtime({}) is None


def test_find_runtime_accepts_node_at_floor(tmp_path, monkeypatch):
    fake = _fake_node(tmp_path / "bin", "22.0.0")
    _isolate_runtime_search(monkeypatch, tmp_path / "bin")
    assert _cli.find_runtime({}) == str(fake)
