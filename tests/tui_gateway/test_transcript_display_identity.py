"""Display identity is additive to physical addressing across retained compaction generations."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_state import SessionDB
from tui_gateway import server


@pytest.mark.parametrize("legacy", [False, True])
def test_rest_and_resume_share_logical_identity_without_duplicate_rows(tmp_path, monkeypatch, legacy):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr("hermes_state.DEFAULT_DB_PATH", tmp_path / "state.db")
    from hermes_cli.web_routers.sessions import manage_router

    db = SessionDB(tmp_path / "state.db")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_set_session_context", lambda *a, **kw: [])
    monkeypatch.setattr(server, "_clear_session_context", lambda tokens: None)
    monkeypatch.setattr(server, "_make_agent", lambda *a, **kw: SimpleNamespace(model="test", provider="test"))
    monkeypatch.setattr(server, "_session_info", lambda *a: {"model": "test", "tools": {}, "skills": {}})
    monkeypatch.setattr(server, "_init_session", lambda *a, **kw: None)
    app = FastAPI()
    app.include_router(manage_router)
    sid = "display-identity"
    try:
        db.create_session(sid, source="desktop")
        original_ids = [db.append_message(sid, role, text, timestamp=stamp) for role, text, stamp in [
            ("user", "again", 10), ("assistant", "same answer", 11),
            ("user", "again", 12), ("assistant", "same answer", 13),
        ]]
        previous_ids = original_ids
        with TestClient(app) as client:
            for _ in range(2):
                retained = db.get_messages_as_conversation(sid, include_row_ids=True)
                db.archive_and_compact(sid, retained)
                if legacy:
                    db._write_sql("UPDATE messages SET display_order = NULL, display_identity = NULL")
                response = client.get(f"/api/sessions/{sid}/messages?include_compacted=true")
                assert response.status_code == 200
                rest = response.json()["messages"]
                resume_response = server.handle_request({"id": "resume", "method": "session.resume", "params": {
                    "session_id": sid, "eager_build": True}})
                assert "result" in resume_response, resume_response
                resumed = resume_response["result"]["messages"]
                assert len(rest) == len(resumed) == len(original_ids)
                physical_ids = [row["id"] for row in rest]
                assert physical_ids == [row["row_id"] for row in resumed]
                assert all(new > old for new, old in zip(physical_ids, previous_ids))
                if legacy:
                    # Read-only legacy stores may lack the index; never synthesize identity from content.
                    assert all("display_order" not in row for row in rest + resumed)
                else:
                    assert [row.get("display_order") for row in rest] == original_ids
                    assert [row.get("display_order") for row in resumed] == original_ids
                assert all("display_identity" not in row for row in rest)
                previous_ids = physical_ids
        assert all("_display_order" not in row and "display_order" not in row
                   for row in db.get_messages_as_conversation(sid))
    finally:
        db.close()
