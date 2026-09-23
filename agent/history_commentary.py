"""Profile-owned, display-only Codex commentary for REST and RPC transcripts.

Adapted from Xipong's PR #107386 (27f853dfe57f3fd031daf9e4702c309aed3f1686).
Provider sidecars, canonical content and reasoning are never rewritten. In
particular, equal commentary/reasoning text is not evidence of contamination:
reasoning sidecars omit unencrypted items and lose cross-channel output order.
"""

import json
from contextlib import contextmanager
from pathlib import Path

from agent.redact import redact_sensitive_text
from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
from hermes_constants import (
    get_process_hermes_home, reset_hermes_home_override, set_hermes_home_override,
)
from utils import is_truthy_value


@contextmanager
def _owning_home(home):
    # Both readers below are profile-scoped: binding only home would let an
    # ambient profile's env expansion / redaction opt-out contaminate this one.
    home = Path(home)
    if home.resolve() == get_process_hermes_home().resolve():
        from tui_gateway.launch_profile_policy import launch_secret_scope
        secrets = launch_secret_scope(home)
    else:
        secrets = build_profile_secret_scope(home)
    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(secrets)
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def visible_commentary(text: str, *, strip_thinking=None) -> str:
    """The same think stripping and secret redaction as live interim delivery."""
    if strip_thinking is None:
        from agent.agent_runtime_helpers import strip_think_blocks
        strip_thinking = lambda value: strip_think_blocks(None, value)
    visible = strip_thinking(text).strip()
    return redact_sensitive_text(visible) if visible else visible


def _commentary_items(message: dict) -> list[str]:
    items = message.get("codex_message_items")
    if isinstance(items, str):
        try:
            items = json.loads(items)
        except ValueError:
            return []
    if not isinstance(items, list):
        return []
    result = []
    for item in items:
        if (not isinstance(item, dict) or item.get("type") != "message"
                or item.get("role") != "assistant"):
            continue
        phase, content = item.get("phase"), item.get("content")
        if not isinstance(phase, str) or phase.strip().lower() != "commentary" or not isinstance(content, list):
            continue
        text = "".join(
            part["text"] for part in content
            if isinstance(part, dict) and part.get("type") == "output_text"
            and isinstance(part.get("text"), str) and part["text"].strip()
        ).strip()
        if text:
            result.append(text)
    return result


def _project_one(message: dict, *, enabled: bool) -> dict:
    if message.get("role") != "assistant" or "codex_message_items" not in message:
        return message
    # Explicit [] prevents a disabled/hidden/malformed row from requesting a
    # frontend fallback to raw provider data. Keep item order and repetitions.
    commentary = []
    if enabled and message.get("display_kind") != "hidden":
        commentary = [part for text in _commentary_items(message) if (part := visible_commentary(text))]
    return {**message, "display_commentary": commentary}


def project_history_commentary(messages: list[dict], *, home) -> list[dict]:
    """Publish only with explicit source ownership; no ambient-profile fallback.

    This read path never initializes a home, hydrates external secret sources,
    backs up config, or mutates stored/model replay rows. No terminal execution
    occurs here, so only the home and secret scopes used by these readers bind.
    """
    if not any(isinstance(m, dict) and "codex_message_items" in m for m in messages):
        return messages
    if home is None or not Path(home).is_dir():
        return [_project_one(m, enabled=False) if isinstance(m, dict) else m for m in messages]
    with _owning_home(home):
        from hermes_cli.config_effective import load_user_config_effective
        try:
            display = load_user_config_effective(fail_closed=True, persist_backup=False).get("display") or {}
            enabled = is_truthy_value(display.get("show_commentary"), default=True) and is_truthy_value(
                display.get("interim_assistant_messages"), default=True)
        except Exception:
            enabled = False  # unreadable policy must not publish provider items
        return [_project_one(m, enabled=enabled) if isinstance(m, dict) else m for m in messages]
