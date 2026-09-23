"""History commentary is a profile-owned display projection, never replay repair.

Projection plumbing adapted from Xipong's PR #107386; ambiguous reasoning
subtraction is deliberately not part of the contract.
"""

from copy import deepcopy
from pathlib import Path

import pytest

from agent.secret_scope import (
    current_secret_scope, reset_secret_scope, set_multiplex_active, set_secret_scope,
)
from hermes_constants import (
    get_hermes_home_override, reset_hermes_home_override, set_hermes_home_override,
)


def _item(text, phase="commentary", **extra):
    return {"type": "message", "role": "assistant", "phase": phase,
            "content": [{"type": "output_text", "text": text}], **extra}


@pytest.mark.parametrize("encoded", [False, True])
@pytest.mark.parametrize("setting", ["show_commentary", "interim_assistant_messages"])
@pytest.mark.parametrize("reasoning", ["Checking files.", "Private summary.\n\nChecking files.",
                                       "Checking files.\n\nChecking files."])
def test_display_projection_uses_owner_policy_and_preserves_every_source(tmp_path, monkeypatch, encoded, setting, reasoning):
    import json

    from agent.redact import register_vault_redaction_value
    from hermes_cli.config import atomic_config_write
    from hermes_cli.web_routers.sessions import _project_for_display
    from tui_gateway.server import _history_to_messages

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "launch"))
    set_multiplex_active(True)
    homes = [tmp_path / "a", tmp_path / "b"]
    for home, enabled in zip(homes, [True, False]):
        home.mkdir()
        # JSON sidecars also exercise settings expanded from the owner's env,
        # never from the ambient profile or launch process.
        value = "${HISTORY_COMMENTARY_ON}" if encoded else enabled
        atomic_config_write(home / "config.yaml", {"display": {setting: value}})
        if encoded:
            (home / ".env").write_text(f"HISTORY_COMMENTARY_ON={str(enabled).lower()}\n", encoding="utf-8")
        token = set_hermes_home_override(str(home))
        try:
            register_vault_redaction_value(f"private-{home.name}-value")
        finally:
            reset_hermes_home_override(token)
    text = "Checking private-a-value and private-b-value. <think>hidden chain</think> ghp_1234567890abcdef"
    row = {"role": "assistant", "content": "Final answer.", "reasoning": reasoning,
           "reasoning_content": reasoning, "_row_id": 19, "_display_order": 7,
           "codex_message_items": [_item(text), _item("Checking files."), _item("Checking files.", "analysis"),
                                   _item("Final answer.", "final_answer")],
           "codex_reasoning_items": [{"type": "reasoning", "id": "rs_test", "encrypted_content": "opaque",
                                      "summary": [{"type": "summary_text", "text": "Checking files."}]}]}
    if encoded:
        row["codex_message_items"] = json.dumps(row["codex_message_items"])
    source = [row, {"role": "user", "content": "Again."}, deepcopy(row)]
    original = deepcopy(source)
    files = {p: p.read_bytes() for home in homes for p in home.rglob("*") if p.is_file()}
    # Ambient context intentionally disagrees with the requested owner, including
    # redaction policy. Home-only scoping would import B's opt-out into A's cache.
    ambient_home = set_hermes_home_override(str(homes[1]))
    ambient_secrets = set_secret_scope({"HERMES_REDACT_SECRETS": "false"})
    try:
        for home in [homes[0], homes[1], homes[0]]:
            rest = _project_for_display(source, home=home)
            rpc = _history_to_messages(source, profile_home=home)
            expected = [] if home == homes[1] else [
                "Checking «redacted-vault-secret» and private-b-value.  ghp_12...cdef", "Checking files."]
            for rows in [rest, rpc]:
                assert [r["display_commentary"] for r in rows if r["role"] == "assistant"] == [expected, expected]
                assert [r["reasoning"] for r in rows if r["role"] == "assistant"] == [row["reasoning"]] * 2
                assert all("display_reasoning" not in r for r in rows)
                assert all("display_content" not in r for r in rows)
                assert rows[0]["codex_message_items"] == original[0]["codex_message_items"]
                assert rows[0]["codex_reasoning_items"] == original[0]["codex_reasoning_items"]
            assert rpc[0]["row_id"] == 19 and rpc[0]["display_order"] == 7
            assert get_hermes_home_override() == str(homes[1])
            assert current_secret_scope() == {"HERMES_REDACT_SECRETS": "false"}
        assert source == original
        assert {p: p.read_bytes() for home in homes for p in home.rglob("*") if p.is_file()} == files
    finally:
        reset_secret_scope(ambient_secrets)
        reset_hermes_home_override(ambient_home)
        set_multiplex_active(False)


@pytest.mark.parametrize("policy", ["default", "broken", "unknown-owner", "missing-owner", "redaction-off"])
def test_projection_never_guesses_channels_or_publishes_without_policy(tmp_path, monkeypatch, policy):
    from agent.history_commentary import project_history_commentary
    from agent.redact import register_vault_redaction_value
    from agent.stream_delivery import StreamDeliveryMixin
    from agent.agent_runtime_helpers import strip_think_blocks
    from hermes_cli.config import atomic_config_write

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    if policy == "broken":
        (tmp_path / "config.yaml").write_text("display: [broken", encoding="utf-8")
    elif policy == "redaction-off":
        atomic_config_write(tmp_path / "config.yaml", {"security": {"redact_secrets": False}})
    text = "Review vault-value. <think>hidden</think> ghp_1234567890abcdef"
    rows = [{"role": "assistant", "content": text, "reasoning": text, "codex_message_items": [
        _item(text), _item(text), _item("private analysis", "analysis"), _item("Final", "final_answer"),
        _item("wrong role", role="user"), _item("bad phase", phase=42),
        {"type": "message", "role": "assistant", "phase": "commentary", "content": "not a parts list"},
        _item("<think>nothing public</think>"),
    ]}, {"role": "assistant", "content": "Final preserved", "codex_message_items": "invalid JSON"},
        {"role": "assistant", "content": "", "display_kind": "hidden", "codex_message_items": [_item(text)]},
        {"role": "user", "content": text, "codex_message_items": [_item(text)]}]
    original = deepcopy(rows)
    token = set_hermes_home_override(str(tmp_path))
    secret_token = set_secret_scope({})
    try:
        register_vault_redaction_value("vault-value")
        home = {"unknown-owner": None, "missing-owner": tmp_path / "missing"}.get(policy, tmp_path)
        display = project_history_commentary(rows, home=home)
        if policy in {"broken", "unknown-owner", "missing-owner"}:
            assert display[0]["display_commentary"] == []
        else:
            class Live(StreamDeliveryMixin):
                _strip_think_blocks = strip_think_blocks
            live = Live()._visible_commentary(text)
            assert display[0]["display_commentary"] == [live, live]
            assert "vault-value" not in live and "hidden" not in live
            assert ("ghp_1234567890abcdef" in live) == (policy == "redaction-off")
        assert display[1]["display_commentary"] == display[2]["display_commentary"] == []
        assert "display_commentary" not in display[3]
        assert all("display_reasoning" not in row and "display_content" not in row for row in display)
        assert display[0]["content"] == display[0]["reasoning"] == text
        assert rows == original
        assert not (tmp_path / "backups").exists()
        assert not (tmp_path / "missing").exists()
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(token)
