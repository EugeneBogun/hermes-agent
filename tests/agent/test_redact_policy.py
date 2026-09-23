"""Only recognized boolean settings may opt out of secret redaction."""

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml


# None in the expectation means invalid/unresolved, not an explicit decision.
_STRING_POLICIES = [
    ("${UNRESOLVED_REDACTION_POLICY}", None), ("not-a-boolean", None), ("", None),
    ("false", False), ("0", False), ("no", False), (" OFF ", False),
    ("true", True), ("1", True), ("yes", True), (" ON ", True),
]


@pytest.mark.parametrize("source", ["config", "dotenv"])
@pytest.mark.parametrize("value,decision", _STRING_POLICIES + [
    (False, False), (0, False), (True, True), (1, True),
    ([], None), ({}, None), (2, None),
])
def test_profile_policy_requires_explicit_boolean(tmp_path, monkeypatch, source, value, decision):
    from agent import redact
    from agent.secret_scope import (
        build_profile_secret_scope, reset_secret_scope, set_secret_scope,
    )
    from hermes_cli import env_loader
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    launch, owner = tmp_path / "launch", tmp_path / "owner"
    launch.mkdir()
    owner.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(launch))
    monkeypatch.delenv("UNRESOLVED_REDACTION_POLICY", raising=False)
    (launch / "config.yaml").write_text("security:\n  redact_secrets: false\n", encoding="utf-8")

    def write_owner(policy):
        if source == "config":
            (owner / "config.yaml").write_text(
                yaml.safe_dump({"security": {"redact_secrets": policy}}), encoding="utf-8")
        else:
            # Quote whitespace/empty values so dotenv preserves the policy token.
            (owner / ".env").write_text(
                f"HERMES_REDACT_SECRETS='{policy}'\n", encoding="utf-8")

    write_owner(value)
    hydrate = Mock(side_effect=AssertionError("redaction must not hydrate external sources"))
    monkeypatch.setattr(env_loader, "hydrate_profile_secret_sources", hydrate)
    # Synthetic credential shape only; never print its value.
    credential = "ghp_" + "redactionpolicyfixture" * 2

    def scrub(home):
        home_token = set_hermes_home_override(str(home))
        secret_token = set_secret_scope(build_profile_secret_scope(home))
        try:
            return redact.redact_sensitive_text(credential)
        finally:
            reset_secret_scope(secret_token)
            reset_hermes_home_override(home_token)

    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert scrub(launch) == credential
    assert (scrub(owner) != credential) is (decision is not False)
    assert scrub(launch) == credential
    assert {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()} == before
    key = str(owner.resolve())
    if decision is None:
        assert key not in redact._REDACT_ENABLED_BY_HOME
        # A provisional secure default must not poison the eventual owner decision.
        write_owner(False)
        assert scrub(owner) == credential
    else:
        assert redact._REDACT_ENABLED_BY_HOME[key] is decision
        # Resolved policy remains snapshotted; runtime mutations cannot disable it.
        write_owner(not decision)
        assert (scrub(owner) != credential) is decision
    assert scrub(launch) == credential
    hydrate.assert_not_called()


@pytest.mark.parametrize("source", ["config", "env"])
@pytest.mark.parametrize("value,decision", _STRING_POLICIES)
def test_launch_policy_defaults_on_and_remains_snapshotted(tmp_path, source, value, decision):
    home = tmp_path / ".hermes"
    home.mkdir()
    config = {"security": {"redact_secrets": value}} if source == "config" else {}
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    (home / ".env").write_text("", encoding="utf-8")
    env = {"HOME": str(tmp_path), "HERMES_HOME": str(home),
           "HERMES_TEST_ISOLATION": str(home), "PATH": os.environ.get("PATH", ""),
           "TMPDIR": str(tmp_path), "TMP": str(tmp_path), "TEMP": str(tmp_path)}
    if source == "env":
        env["HERMES_REDACT_SECRETS"] = value
    # Exercise the real launch config bridge before the import-time snapshot.
    probe = """
import os
import hermes_cli.main
from agent.redact import redact_sensitive_text
credential = 'ghp_' + 'launchpolicyfixture' * 2
expected = EXPECTED
assert (redact_sensitive_text(credential) != credential) is expected
os.environ['HERMES_REDACT_SECRETS'] = 'false' if expected else 'true'
assert (redact_sensitive_text(credential) != credential) is expected
""".replace("EXPECTED", repr(decision is not False))
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=Path(__file__).resolve().parents[2],
        env=env, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
