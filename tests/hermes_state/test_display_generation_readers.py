"""Display readers share occurrence lineage, legacy fallback, and rotation clone identity."""

import pytest

from hermes_state import SessionDB
from hermes_state_timeline import get_session_messages_around, get_session_timeline


@pytest.mark.parametrize("read_only", [True, False])
@pytest.mark.parametrize("role", ["assistant", "tool"])
@pytest.mark.parametrize("legacy", ["unrelated", "mixed", "all"])
def test_legacy_page_preserves_indexed_occurrences(tmp_path, read_only, role, legacy):
    path = tmp_path / "state.db"
    with SessionDB(path) as db:
        db.create_session("s", source="desktop")
        rewind = db.append_message("s", "user", "withdraw this", timestamp=99)
        withdrawn = db.append_message("s", role, "hello", timestamp=100)
        db.rewind_to_message("s", rewind)
        # Assistant loading changes bytes. Two distinct indexed occurrences may then
        # share a fingerprint, but their known lineage must still win over that guess.
        contents = ["  hello  ", "hello"] if role == "assistant" and legacy == "unrelated" else ["hello", "hello"]
        stamps = [100, 100] if role == "assistant" and legacy == "unrelated" else [100, 101]
        originals = [db.append_message("s", role, text, timestamp=ts)
                     for text, ts in zip(contents, stamps)]
        carried = db.get_messages_as_conversation("s", include_row_ids=True)
        db.archive_and_compact("s", carried)
        expected = [row["_row_id"] for row in carried]
        if legacy != "unrelated":
            scope = "AND active = 0" if legacy == "mixed" else ""
            db._write_sql(
                f"UPDATE messages SET display_identity = NULL, display_order = id WHERE session_id = ? {scope}",
                ("s",))
        db._write_sql("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                      ("s", "user", "unrelated legacy ask", 200))
        unrelated = db.get_messages("s")[-1]["id"]
        expected.append(unrelated)
        with SessionDB(path, read_only=read_only) as reader:
            # Read all projections before a writable REST backfill can hide disagreement.
            _, resume = reader.get_resume_conversations("s")
            warm = reader.get_messages_as_conversation("s", include_compacted=True, include_row_ids=True)
            visible = reader.get_messages("s", include_compacted=True)
            assert [row["id"] for row in visible] == expected
            for projection in (resume, warm):
                assert [row["_row_id"] for row in projection] == expected
            if legacy == "unrelated":
                assert [row["display_order"] for row in visible[:-1]] == originals
            for latest in (False, True):
                for offset in range(len(expected)):
                    page = reader.get_messages("s", include_compacted=True, limit=1, offset=offset, latest=latest)
                    assert [row["id"] for row in page] == [expected[::-1][offset] if latest else expected[offset]]
            assert withdrawn not in expected
            assert all(row["active"] or row["compacted"] for row in visible)
            assert withdrawn in [row["id"] for row in reader.get_messages("s", include_inactive=True)]


@pytest.mark.parametrize("read_only", [True, False])
@pytest.mark.parametrize("compact_child", [False, True])
@pytest.mark.parametrize("collision", [None, "first", "last"])
def test_rotation_display_collapses_sql_clones_not_repeated_turns(tmp_path, read_only, compact_child, collision):
    path = tmp_path / "state.db"
    with SessionDB(path) as db, SessionDB(path) as appender:
        db.create_session("parent", source="desktop")
        rewind = db.append_message("parent", "user", "withdraw this", timestamp=99)
        withdrawn = db.append_message("parent", "assistant", "tail reply", timestamp=101)
        db.rewind_to_message("parent", rewind)
        old = db.append_message("parent", "user", "old", timestamp=90)
        watermark = db.get_active_message_watermark("parent")
        # Real second connection: foreign tail arrives after the compressor's snapshot.
        # The exact-byte join may be visited before OR after the colliding fingerprint.
        appender.append_messages_batch("parent", [
            {"role": "user", "content": "during compression", "timestamp": 100},
            {"role": "assistant", "content": "tail reply" if collision == "first" else "  tail reply  ", "timestamp": 101},
            {"role": "tool", "content": "same result", "tool_call_id": "call", "timestamp": 102},
            {"role": "assistant", "content": "tail reply" if collision == "last" else "  tail reply  ",
             "timestamp": 101 if collision else 103},
            {"role": "tool", "content": "same result", "tool_call_id": "call", "timestamp": 104},
        ])
        tail = appender.get_messages("parent")[1:]
        assert db.try_acquire_compression_lock("parent", "owner")
        handoff = [{"role": "user", "content": "summary", "timestamp": 110, "_compressed_summary": True}]
        db.publish_compression_child(
            parent_session_id="parent", child_session_id="child", source="desktop",
            messages=handoff, watermark=watermark, compression_lock_holder="owner")
        child_tail = db.get_messages("child")[1:]
        assert [row["display_order"] for row in child_tail] != [row["display_order"] for row in tail]
        for _ in range(2 if compact_child else 0):
            carried = db.get_messages_as_conversation("child", include_row_ids=True)
            db.archive_and_compact("child", carried)
        with SessionDB(path, read_only=read_only) as reader:
            child = reader.get_messages("child", include_compacted=True)
            expected = [old, *[row["id"] for row in child[1:]], child[0]["id"]]
            _, resume = reader.get_resume_conversations("child")
            warm = reader.get_messages_as_conversation(
                "child", include_ancestors=True, include_compacted=True, include_row_ids=True)
            for projection in (resume, warm):
                assert [row["_row_id"] for row in projection] == expected
                assert [row["content"] for row in projection if row["role"] == "assistant"] == ["tail reply"] * 2
                assert [row["content"] for row in projection if row["role"] == "tool"] == ["same result"] * 2
                assert withdrawn not in [row["_row_id"] for row in projection]
            assert [row["content"] for row in reader.get_ancestor_display_prefix("child")] == ["old"]


@pytest.mark.parametrize("read_only", [True, False])
def test_mixed_timeline_and_jump_share_carried_occurrences(tmp_path, read_only):
    path = tmp_path / "state.db"
    with SessionDB(path) as db:
        db.create_session("s", source="desktop")
        originals = [db.append_message("s", role, text, timestamp=100 + index)
                     for index, (role, text) in enumerate([
                         ("user", "  question  "), ("assistant", "  repeated  "),
                         ("assistant", "repeated"), ("user", "next question")])]
        carried = db.get_messages_as_conversation("s", include_row_ids=True)
        db.archive_and_compact("s", carried)
        db._write_sql("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                      ("s", "user", "unrelated", 200))
        withdrawn = db.append_message("s", "user", "withdrawn", timestamp=201)
        db.rewind_to_message("s", withdrawn)
        with SessionDB(path, read_only=read_only) as reader:
            # Timeline/jump must work before writable page backfill repairs the legacy row.
            first = get_session_timeline(reader, "s", limit=1)
            assert first["entries"][0]["row_id"] == carried[0]["_row_id"]
            cursor = first["pagination"]["next_cursor"]
            assert cursor == originals[0]
            assert first["pagination"]["total"] == 3
            jump = get_session_messages_around(reader, "s", carried[0]["_row_id"])
            assert jump is not None
            visible = reader.get_messages("s", include_compacted=True)
            expected = [row["id"] for row in visible]
            _, resume = reader.get_resume_conversations("s")
            assert [row["_row_id"] for row in resume] == expected
            assert [row["id"] for row in jump["messages"]] == expected
            assert jump["pagination"]["total"] == len(expected)
            assert jump["pagination"]["offset"] == 0
            assert get_session_messages_around(reader, "s", withdrawn) is None
            # A cursor addresses the occurrence, not its new representative after compaction.
            carried = db.get_messages_as_conversation("s", include_row_ids=True)
            db.archive_and_compact("s", carried)
            later = get_session_timeline(reader, "s", limit=1, after_row_id=cursor)
            assert later["entries"][0]["row_id"] == carried[3]["_row_id"]
            assert later["pagination"]["next_cursor"] == originals[3]
            last = get_session_timeline(reader, "s", limit=1,
                                        after_row_id=later["pagination"]["next_cursor"])
            assert last["entries"][0]["row_id"] == carried[-1]["_row_id"]
            assert last["pagination"]["total"] == first["pagination"]["total"]
            assert not last["pagination"]["has_more"]
            assert last["pagination"]["next_cursor"] is None
