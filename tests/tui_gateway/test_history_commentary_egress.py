"""Every transcript egress uses its source home's commentary policy, not ambient scope."""

from copy import deepcopy
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_state import SessionDB
from tui_gateway import server


@pytest.mark.parametrize("disabled_setting", ["show_commentary", "interim_assistant_messages"])
def test_rest_resume_live_history_and_host_ack_share_owned_projection(tmp_path, monkeypatch, disabled_setting):
    from hermes_cli.config import atomic_config_write
    from hermes_cli.web_routers.sessions import manage_router
    from tui_gateway.compute_host import ComputeHost

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    a, b = tmp_path / ".hermes", tmp_path / ".hermes" / "profiles" / "b"
    b.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(a))
    monkeypatch.setattr(server, "_hermes_home", a)
    monkeypatch.setattr("hermes_state.DEFAULT_DB_PATH", a / "state.db")
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_session_info", lambda *args: {"model": "fixture"})
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    dbs = {}
    row_ids = {}
    sidecar = [{"type": "message", "role": "assistant", "phase": "commentary",
                "content": [{"type": "output_text", "text": "Checking files. <think>not public</think>"}]}]
    for name, home, enabled in [("default", a, True), ("b", b, False)]:
        atomic_config_write(home / "config.yaml", {"display": {disabled_setting: enabled}})
        db = dbs[name] = SessionDB(home / "state.db")
        db.create_session("same-id", source="desktop", profile_name=name)
        row_ids[name] = db.append_message("same-id", "user", "Do it.")
        db.append_message("same-id", "assistant", "Final answer.", reasoning="Checking files.",
                          codex_message_items=sidecar)
    monkeypatch.setattr(server, "_get_db", lambda: dbs["default"])
    app = FastAPI()
    app.include_router(manage_router)
    original = {name: db.get_messages_as_conversation("same-id") for name, db in dbs.items()}
    try:
        with TestClient(app) as client:
            for name in ["default", "b", "default"]:
                expected = ["Checking files."] if name == "default" else []
                profile = {"profile": name} if name != "default" else {}
                # The REST read uses the DB selected by the request, including a
                # custom launch home when profile is omitted.
                rest = client.get("/api/sessions/same-id/messages", params=profile)
                around = client.get("/api/sessions/same-id/messages/around", params={**profile, "row_id": row_ids[name]})
                assert rest.status_code == around.status_code == 200
                resumed = server.handle_request({"id": "resume", "method": "session.resume", "params": {
                    "session_id": "same-id", "lazy": True, **profile}})
                assert "result" in resumed, resumed
                result = resumed["result"]
                sid = result["session_id"]
                session = server._sessions[sid]
                snapshot = deepcopy(session["history"])
                other_home = b if name == "default" else a
                token = set_hermes_home_override(str(other_home))
                try:
                    live = server._live_session_payload(sid, session)
                    history = server.handle_request({"id": "history", "method": "session.history", "params": {"session_id": sid}})
                    assert "result" in history, history
                    # The compute-host projection is off the RPC dispatcher path.
                    host = ComputeHost.__new__(ComputeHost)
                    ack = host._control_ack(server, {"sid": sid, "route_name": "slash.history"}, session)
                finally:
                    reset_hermes_home_override(token)
                for payload in [rest.json(), around.json(), result, live, history["result"], ack]:
                    assistant = next(row for row in payload["messages"] if row["role"] == "assistant")
                    assert assistant.get("display_commentary") == expected, (name, assistant)
                    assert assistant["reasoning"] == "Checking files."
                    assert "display_reasoning" not in assistant
                    raw = assistant["codex_message_items"]
                    assert (json.loads(raw) if isinstance(raw, str) else raw) == sidecar
                assert session["history"] == snapshot
        assert {name: db.get_messages_as_conversation("same-id") for name, db in dbs.items()} == original
    finally:
        server._sessions.clear()
        for db in dbs.values():
            db.close()
