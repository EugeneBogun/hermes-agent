"""Compaction changes physical addresses, never the carried occurrence's display identity."""

import pytest

from hermes_state import SessionDB
from hermes_state_timeline import get_session_messages_around, get_session_timeline


@pytest.mark.parametrize("mode", ["protected", "protected_without_ids", "carried", "concurrent", "combined"])
@pytest.mark.parametrize("read_only", [False, True])
def test_compaction_keeps_occurrences_and_cursor_boundaries(tmp_path, mode, read_only):
    path = tmp_path / "state.db"
    with SessionDB(path) as db, SessionDB(path) as appender:
        sid = "conversation"
        db.create_session(sid, source="desktop")
        # A taken-back occurrence must not become the logical anchor for its replacement.
        withdrawn = db.append_message(sid, "user", "again", timestamp=100)
        db.rewind_to_message(sid, withdrawn)
        db.append_messages_batch(sid, [
            {"role": role, "content": text, "timestamp": 100 + i}
            for i, (role, text) in enumerate([("user", "again"), ("assistant", "same reply")] * 3)
        ])
        expected = [row["display_order"] for row in db.get_messages(sid)]
        assert withdrawn not in expected
        assert len(set(expected)) == len(expected)
        cursor = get_session_timeline(db, sid, limit=2)["pagination"]["next_cursor"]
        expected_after_cursor = expected[4::2]

        for epoch in range(2):
            live = [{**row, "_row_id": row["id"]} for row in db.get_messages(sid)]
            ordinary = [row for row in live if not row.get("_compressed_summary")]
            watermark = db.get_active_message_watermark(sid)
            carried = ordinary[:2] + ordinary[-2:] if mode == "carried" else ordinary[-2:]
            if mode == "concurrent":
                carried = []
            if mode in {"concurrent", "combined"}:
                # Another real connection commits while the compressor holds its snapshot watermark.
                appender.append_messages_batch(sid, [
                    {"role": "user", "content": "again", "timestamp": 200 + epoch * 2},
                    {"role": "assistant", "content": "same reply", "timestamp": 201 + epoch * 2},
                ])
                added = appender.get_messages(sid)[-2:]
                expected.extend(row["display_order"] for row in added)
                expected_after_cursor.append(added[0]["display_order"])
            if mode == "protected_without_ids":
                carried = [{k: v for k, v in row.items() if not k.startswith("_")} for row in carried]
            old_ids = {row["id"] for row in db.get_messages(sid)}
            compacted = [{"role": "user", "content": f"summary {epoch}", "_compressed_summary": True}, *carried]
            db.archive_and_compact(
                sid, compacted, watermark=watermark if epoch or mode in {"concurrent", "combined"} else None,
                carried_messages=carried if mode == "carried" else None,
                tail_count=0 if mode == "carried" else len(carried))

            reader = SessionDB(path, read_only=True) if read_only else db
            try:
                visible = reader.get_messages(sid, include_compacted=True)
                occurrences = [row for row in visible if not row.get("_compressed_summary")]
                assert [row["display_order"] for row in occurrences] == expected
                assert all(row["id"] not in old_ids for row in reader.get_messages(sid))
                # All resume and page readers must agree on occurrence order, not clone insertion order.
                resume = reader.get_messages_as_conversation(
                    sid, include_compacted=True, include_row_ids=True)
                assert [row["_row_id"] for row in resume] == [row["id"] for row in visible]
                _, resumed_display = reader.get_resume_conversations(sid)
                assert [row["_row_id"] for row in resumed_display] == [row["id"] for row in visible]
                for offset in range(0, len(visible), 2):
                    page = reader.get_messages(sid, include_compacted=True, offset=offset, limit=2)
                    assert page == visible[offset:offset + 2]
                later = get_session_timeline(reader, sid, after_row_id=cursor)
                row_orders = {row["id"]: row["display_order"] for row in visible}
                assert [row_orders[entry["row_id"]] for entry in later["entries"]
                        if entry["preview"] == "again"] == expected_after_cursor
                assert withdrawn not in row_orders
                assert get_session_messages_around(reader, sid, withdrawn) is None
                audit = reader.get_messages(sid, include_inactive=True)
                assert any(row["id"] == withdrawn and not row["active"] and not row["compacted"] for row in audit)
                assert all(row["active"] or row["compacted"] for row in visible)
            finally:
                if read_only:
                    reader.close()


@pytest.mark.parametrize("read_only", [False, True])
def test_mixed_compaction_modes_preserve_surviving_lineage(tmp_path, read_only):
    path = tmp_path / "state.db"
    with SessionDB(path) as db:
        db.create_session("s", source="desktop")
        withdrawn = db.append_message("s", "user", "hello", timestamp=100)
        db.rewind_to_message("s", withdrawn)
        original = db.append_message("s", "user", "hello", timestamp=100)
        for tail_count in (1, 0, 1):
            retained = db.get_messages_as_conversation("s", include_row_ids=True)
            db.archive_and_compact("s", retained, tail_count=tail_count)
            # Even archived peers retain the occurrence's order when its live source retires.
            peers = [row for row in db.get_messages("s", include_inactive=True)
                     if row["active"] or row["compacted"]]
            assert {row["display_order"] for row in peers} == {original}
        reader = SessionDB(path, read_only=True) if read_only else db
        try:
            visible = reader.get_messages("s", include_compacted=True)
            assert [row["display_order"] for row in visible] == [original]
            assert visible[0]["id"] == retained[0]["_row_id"]
            assert get_session_messages_around(reader, "s", withdrawn) is None
        finally:
            if read_only:
                reader.close()


@pytest.mark.parametrize("read_only", [False, True])
@pytest.mark.parametrize("legacy", [None, "unindexed", "order_only", "mixed"])
def test_resume_dedupes_carriers_by_indexed_occurrence(tmp_path, read_only, legacy):
    path = tmp_path / "state.db"
    with SessionDB(path) as db:
        db.create_session("s", source="desktop")
        # Separate same-text occurrences must survive; only each one's carrier collapses.
        content = "hello" if legacy else "  hello  "
        originals = [db.append_message("s", "assistant", content, timestamp=ts) for ts in (100, 101)]
        retained = db.get_messages_as_conversation("s", include_row_ids=True)
        db.archive_and_compact("s", retained)
        if legacy:
            order = "id" if legacy == "order_only" else "NULL"
            scope = " WHERE active = 0" if legacy == "mixed" else ""
            db._write_sql(f"UPDATE messages SET display_order = {order}, display_identity = NULL{scope}")
        reader = SessionDB(path, read_only=True) if read_only else db
        try:
            _, resume = reader.get_resume_conversations("s")
            warm = reader.get_messages_as_conversation("s", include_compacted=True, include_row_ids=True)
            rest = reader.get_messages("s", include_compacted=True)
            expected_ids = [msg["_row_id"] for msg in retained]
            assert [row["id"] for row in rest] == expected_ids
            for projection in (resume, warm):
                assert [row["_row_id"] for row in projection] == expected_ids
                assert [row["content"] for row in projection] == ["hello", "hello"]
                if not legacy:
                    assert [row["_display_order"] for row in projection] == originals
        finally:
            if read_only:
                reader.close()


@pytest.mark.parametrize("source", ["live", "rewound", "foreign", "wrong_occurrence", "invalid", "changed", "unproven_tail"])
def test_compaction_inherits_only_the_selected_live_occurrence(tmp_path, source):
    with SessionDB(tmp_path / "state.db") as db:
        db.create_session("s", source="desktop")
        db.create_session("other", source="desktop")
        foreign = db.append_message("other", "user", "again", timestamp=100)
        rewound = db.append_message("s", "user", "again", timestamp=100)
        db.rewind_to_message("s", rewound)
        earlier = db.append_message("s", "user", "again", timestamp=99)
        original = db.append_message("s", "user", "again", timestamp=100)
        target = {"live": original, "rewound": rewound, "foreign": foreign,
                  "wrong_occurrence": earlier, "invalid": True, "changed": original, "unproven_tail": None}[source]
        carried = {"role": "user", "content": "edited" if source == "changed" else "again",
                   "timestamp": 100, "_row_id": target, "_display_order": foreign,
                   "display_order": foreign}
        if source == "unproven_tail":
            carried.pop("_row_id")
            carried.pop("timestamp")
        db.archive_and_compact("s", [carried], tail_count=1)
        stored = db.get_messages("s")[0]
        assert stored["display_order"] == (original if source == "live" else stored["id"])
        assert carried.get("_display_order", stored["display_order"]) == stored["display_order"]
        assert get_session_messages_around(db, "s", rewound) is None
        assert db.get_messages("other")[0]["id"] == foreign


@pytest.mark.parametrize("read_only", [False, True])
def test_unrelated_legacy_backfill_does_not_remint_carried_identity(tmp_path, read_only):
    path = tmp_path / "state.db"
    with SessionDB(path) as db:
        db.create_session("s", source="desktop")
        db.append_messages_batch("s", [
            {"role": "user", "content": "again", "timestamp": 100},
            {"role": "assistant", "content": "reply", "timestamp": 101},
        ])
        original = db.get_messages("s")
        expected = [row["display_order"] for row in original]
        db.archive_and_compact("s", [
            {"role": "user", "content": "summary", "_compressed_summary": True}, *original,
        ], tail_count=2)
        # One legacy/unindexed row must not erase valid lineage elsewhere in the session.
        db._write_sql("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                      ("s", "user", "new ask", 200))
        reader = SessionDB(path, read_only=True) if read_only else db
        try:
            visible = reader.get_messages("s", include_compacted=True)
            assert [row["display_order"] for row in visible[:2]] == expected
            timeline = get_session_timeline(reader, "s", limit=1)
            assert timeline["entries"][0]["preview"] == "again"
            assert timeline["pagination"]["next_cursor"] == expected[0]
            jump = get_session_messages_around(reader, "s", visible[0]["id"], limit=2)
            assert jump is not None
            assert [row["display_order"] for row in jump["messages"]] == expected
        finally:
            if read_only:
                reader.close()
