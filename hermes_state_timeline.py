"""Read-only prompt index and bounded transcript jumps; no transcript-wide payload hydration."""

from __future__ import annotations

import json
import re
from contextlib import contextmanager

from agent.compaction_display import project_compaction_message_for_display
from agent.context_compressor import user_originated_turn_view


_SYNTHETIC_PROMPT = re.compile(
    r"^\s*(?:\[IMPORTANT: Background process |\[ASYNC (?:DELEGATION )?(?:BATCH )?COMPLETE\b|"
    r"A background fan-out of \d+ subagent\(s\) you dispatched earlier has finished\.|"
    r"A background subagent you dispatched earlier has finished\.)",
    re.IGNORECASE,
)


def _prompt_preview(db, content, display_kind, summary):
    message = project_compaction_message_for_display({
        "role": "user", "content": db._decode_content(content),
        "display_kind": display_kind, "_compressed_summary": bool(summary),
    })
    if message is None or user_originated_turn_view(message) is None:
        return ""
    content = message.get("content")
    if isinstance(content, list):
        content = " ".join(
            part if isinstance(part, str) else part.get("text", "")
            for part in content if isinstance(part, (str, dict)))
    if not isinstance(content, str):
        return ""
    text = " ".join(content.split())
    if not text or _SYNTHETIC_PROMPT.match(text):
        return ""
    return text if len(text) <= 120 else text[:119].rstrip() + "…"


@contextmanager
def _snapshot(db):
    # The count and page must see the same compaction/rewind generation.
    with db._read_ctx() as conn:
        conn.execute("BEGIN")
        try:
            yield conn
        finally:
            if conn.in_transaction:
                conn.execute("ROLLBACK")


def _display_rows_sql(db, conn, session_id, params, *, users_only=False):
    """Return only representative ids and their stable first-row order, never bodies.

    Legacy stores cannot backfill on a GET. Reuse the page/resume grouping, retaining
    only ids and logical orders from the streaming scan inside the same snapshot.
    Current stores use the durable display index, including protected-tail copies.
    """
    role = " AND role = 'user'" if users_only else ""
    indexed = conn.execute(
        "SELECT 1 FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) "
        f"{role} AND (display_order IS NULL OR display_identity IS NULL) LIMIT 1",
        (session_id,),
    ).fetchone() is None
    if indexed:
        return f"""WITH display_rows AS (
            SELECT (SELECT candidate.id FROM messages candidate
                    WHERE candidate.session_id = :sid
                      AND candidate.display_order = m.display_order
                      AND (candidate.active = 1 OR candidate.compacted = 1)
                    ORDER BY candidate.active DESC, candidate.id DESC LIMIT 1) AS row_id,
                   m.display_order AS sort_id
            FROM messages m WHERE session_id = :sid AND (active = 1 OR compacted = 1){role}
            GROUP BY m.display_order
        )"""
    orders = db._legacy_display_orders(
        conn, session_id, active_clause=db._active_clause(False, True), users_only=users_only)
    params["display_rows"] = json.dumps(list(orders.items()))
    return """WITH display_rows AS (
        SELECT json_extract(value, '$[0]') AS row_id, json_extract(value, '$[1]') AS sort_id
        FROM json_each(:display_rows)
    )"""


def _register_functions(db, conn):
    conn.create_function("timeline_preview", 3,
                         lambda content, kind, summary: _prompt_preview(db, content, kind, summary),
                         deterministic=True)


def get_session_messages_around(db, session_id, row_id, *, limit=120):
    """Read at most *limit* display rows starting at an exact human prompt.

    Existence probes/counts contain ids only. Full payloads are fetched only for
    the selected bounded page, even when the anchor is deep in a transcript.
    """
    with _snapshot(db) as conn:
        _register_functions(db, conn)
        anchor = conn.execute(
            "SELECT content, display_kind, _compressed_summary FROM messages "
            "WHERE session_id = ? AND id = ? AND role = 'user' AND (active = 1 OR compacted = 1)",
            (session_id, row_id),
        ).fetchone()
        if anchor is None or not _prompt_preview(db, *anchor):
            return None
        params = {"sid": session_id, "row_id": row_id, "limit": limit}
        sql = _display_rows_sql(db, conn, session_id, params)
        selected = conn.execute(sql + """
            SELECT sort_id FROM display_rows WHERE row_id = :row_id
        """, params).fetchone()
        if selected is None:
            return None
        params["start"] = selected["sort_id"]
        counts = conn.execute(sql + """
            SELECT COUNT(*) AS total, COALESCE(SUM(sort_id < :start), 0) AS offset FROM display_rows
        """, params).fetchone()
        rows = conn.execute(sql + """
            SELECT m.* FROM (SELECT row_id, sort_id FROM display_rows
                            WHERE sort_id >= :start ORDER BY sort_id LIMIT :limit) AS page
            JOIN messages m ON m.id = page.row_id ORDER BY page.sort_id
        """, params).fetchall()
    messages = [db._row_to_message_dict(row, warn_context="timeline jump", summary_flag=True) for row in rows]
    return {"messages": messages, "pagination": {
        "row_id": row_id, "limit": limit, "returned": len(messages), "order": "oldest",
        "offset": counts["offset"], "total": counts["total"],
        "has_older": counts["offset"] > 0,
        "has_newer": counts["offset"] + len(messages) < counts["total"],
    }}


def get_session_timeline(db, session_id, *, limit=500, after_row_id=0):
    """Chronological prompts. Cursor is the first physical row id of a logical turn."""
    with _snapshot(db) as conn:
        _register_functions(db, conn)
        params = {"sid": session_id, "after": after_row_id, "limit": limit + 1}
        sql = _display_rows_sql(db, conn, session_id, params, users_only=True) + """,
            prompts AS MATERIALIZED (
                SELECT row_id, sort_id, m.timestamp,
                       timeline_preview(m.content, m.display_kind, m._compressed_summary) AS preview
                FROM display_rows JOIN messages m ON m.id = row_id
            ), eligible AS MATERIALIZED (SELECT * FROM prompts WHERE preview <> '')
        """
        rows = conn.execute(sql + """
            SELECT row_id, sort_id, timestamp, preview, (SELECT COUNT(*) FROM eligible) AS total
            FROM eligible WHERE sort_id > :after ORDER BY sort_id LIMIT :limit
        """, params).fetchall()
        total = rows[0]["total"] if rows else conn.execute(
            sql + "SELECT COUNT(*) FROM eligible", params).fetchone()[0]
    has_more = len(rows) > limit
    page = rows[:limit]
    return {
        "entries": [{"row_id": row["row_id"], "preview": row["preview"], "timestamp": row["timestamp"]}
                    for row in page],
        "pagination": {"limit": limit, "after_row_id": after_row_id, "returned": len(page),
                       "total": total, "has_more": has_more,
                       "next_cursor": page[-1]["sort_id"] if has_more else None},
    }
