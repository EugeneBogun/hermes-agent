"""REST-first history reads must not borrow or cache the launch owner's policy."""

import asyncio
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.mark.parametrize("endpoint", ["messages", "messages/around"])
@pytest.mark.parametrize("owner_redact", ["true", "false"])
@pytest.mark.parametrize("owner_show,owner_policy", [
    ("${ONLY_LAUNCH_SHOW}", "${ONLY_LAUNCH_REDACT}"),
    (True, "${ONLY_LAUNCH_REDACT}"),
    (True, "not-a-boolean"),
])
def test_rest_first_new_profile_keeps_policy_and_redaction_cache_owned(
    tmp_path, monkeypatch, endpoint, owner_redact, owner_show, owner_policy,
):
    from agent import history_commentary, redact
    from agent.secret_scope import set_multiplex_active
    from hermes_cli import env_loader
    from hermes_cli.config import atomic_config_write
    from hermes_cli.web_routers.sessions import manage_router
    from hermes_state import SessionDB
    from tui_gateway.launch_profile_policy import activate_multi_profile_hosting_eagerly

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    launch = tmp_path / ".hermes"
    launch.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(launch))
    monkeypatch.setattr("hermes_state.DEFAULT_DB_PATH", launch / "state.db")
    monkeypatch.setenv("ONLY_LAUNCH_SHOW", "true")
    monkeypatch.setenv("ONLY_LAUNCH_REDACT", "false")
    policy = {"display": {"show_commentary": "${ONLY_LAUNCH_SHOW}"},
              "security": {"redact_secrets": "${ONLY_LAUNCH_REDACT}"}}
    atomic_config_write(launch / "config.yaml", policy)
    set_multiplex_active(False)
    assert activate_multi_profile_hosting_eagerly() is False

    # The first contact with this post-boot profile is REST, not an RPC or turn
    # that would already have activated multi-profile hosting.
    owner = launch / "profiles" / "secondary"
    owner.mkdir(parents=True)
    atomic_config_write(owner / "config.yaml", {
        "display": {"show_commentary": owner_show},
        "security": {"redact_secrets": owner_policy},
    })
    # Deliberately synthetic credential shape, never a real credential.
    credential = "ghp_" + "historyprivacyfixture" * 2
    text = f"Checking {credential}. <think>private chain</think>"
    visible = f"Checking {credential}."
    sidecar = [{"type": "message", "role": "assistant", "phase": "commentary",
                "content": [{"type": "output_text", "text": text}]}]
    rows = {}
    for home in (launch, owner):
        with SessionDB(home / "state.db") as db:
            db.create_session("same-id", source="desktop",
                              profile_name="default" if home == launch else "secondary")
            rows[home] = db.append_message("same-id", "user", "Check it.")
            db.append_message("same-id", "assistant", "Final.", reasoning=text,
                              codex_message_items=sidecar)

    def files():
        return {p.relative_to(launch): p.read_bytes()
                for p in launch.rglob("*")
                if p.is_file() and not p.name.endswith(("-wal", "-shm"))}

    before = files()
    hydrate = Mock(side_effect=AssertionError("history must not hydrate external sources"))
    monkeypatch.setattr(env_loader, "hydrate_profile_secret_sources", hydrate)
    project = history_commentary.project_history_commentary
    projected_homes = []

    def off_loop_projection(messages, *, home):
        with pytest.raises(RuntimeError):
            asyncio.get_running_loop()
        projected_homes.append(Path(home))
        return project(messages, home=home)

    monkeypatch.setattr(history_commentary, "project_history_commentary", off_loop_projection)
    app = FastAPI()
    app.include_router(manage_router)
    with TestClient(app) as client:
        def commentary(home):
            params = {"profile": "secondary"} if home == owner else {}
            if endpoint.endswith("/around"):
                params["row_id"] = rows[home]
            result = client.get(f"/api/sessions/same-id/{endpoint}", params=params)
            assert result.status_code == 200, result.text
            row = next(row for row in result.json()["messages"] if row["role"] == "assistant")
            assert row["content"] == "Final." and row["reasoning"] == text
            raw = row["codex_message_items"]
            assert (json.loads(raw) if isinstance(raw, str) else raw) == sidecar
            return row["display_commentary"]

        assert commentary(launch) == [visible]  # legitimate launch-only opt-out
        cold = commentary(owner)
        if owner_show is True:
            assert len(cold) == 1 and credential not in cold[0]
            assert "private chain" not in cold[0]
        else:
            assert cold == []
        # An unresolved redaction setting is not an owner's permanent decision.
        assert str(owner.resolve()) not in redact._REDACT_ENABLED_BY_HOME
        assert files() == before

        # The first read must not poison B's eventual owner policy or change
        # the launch profile's legitimate explicit opt-out.
        assert commentary(launch) == [visible]
        if owner_policy != "${ONLY_LAUNCH_REDACT}":
            atomic_config_write(owner / "config.yaml", policy)
        (owner / ".env").write_text(
            f"ONLY_LAUNCH_SHOW=true\nONLY_LAUNCH_REDACT={owner_redact}\n", encoding="utf-8")
        after_policy = files()
        owned = commentary(owner)
        assert len(owned) == 1
        assert (credential in owned[0]) == (owner_redact == "false")
        assert redact._REDACT_ENABLED_BY_HOME[str(owner.resolve())] == (owner_redact == "true")
        assert commentary(launch) == [visible]
        assert files() == after_policy
    assert set(projected_homes) == {launch, owner}
    hydrate.assert_not_called()
