"""Codex commentary is public progress, never normalized Thinking (#119716).

The phase-separation fix builds on Xipong's PR #107350; exercise the real
stream/transport/storage/replay seams rather than a copied normalizer method.
"""

from copy import deepcopy
from types import SimpleNamespace as NS

import pytest

from agent.codex_responses_adapter import _chat_messages_to_responses_input
from agent.codex_runtime import _consume_codex_event_stream
from agent.transports.codex import ResponsesApiTransport
from run_agent import AIAgent


def _message(text, phase):
    return NS(type="message", role="assistant", id=f"msg_{phase}", phase=phase,
              status="completed", content=[NS(type="output_text", text=text)])


@pytest.mark.parametrize("show_commentary", [False, True])
@pytest.mark.parametrize("ending", ["tool", "final", "commentary_only"])
@pytest.mark.parametrize("summary", ["Private summary.", "Checking files."])
def test_commentary_channels_preserve_reasoning_and_provider_replay(show_commentary, ending, summary):
    commentary = _message("Checking files.", "commentary")
    analysis = _message("Private analysis.", "analysis")
    reasoning = NS(type="reasoning", id="rs_summary", status="completed",
                   encrypted_content="opaque-replay-state",
                   summary=[NS(type="summary_text", text=summary)])
    output = [commentary] if ending == "commentary_only" else [reasoning, commentary, analysis]
    if ending == "tool":
        output.append(NS(type="function_call", id="fc_check", call_id="call_check",
                         name="terminal", arguments="{}", status="completed"))
    elif ending == "final":
        output.append(_message("Checked.", "final_answer"))
    original = deepcopy(output)
    events = []
    for item in output:
        events.append(NS(type="response.output_item.added", item=item))
        if item.type == "message":
            events.append(NS(type="response.output_text.delta", delta=item.content[0].text))
        elif item.type == "reasoning":
            events.append(NS(type="response.reasoning_summary_text.delta", delta=summary))
        events.append(NS(type="response.output_item.done", item=item))
    events.append(NS(type="response.completed", response=NS(status="completed")))
    live_commentary, live_reasoning, live_text = [], [], []
    response = _consume_codex_event_stream(
        events, model="test-model", on_text_delta=live_text.append,
        on_reasoning_delta=live_reasoning.append,
        on_commentary_message=live_commentary.append if show_commentary else None,
    )
    # Preserve the documented low-level no-consumer/explicit-opt-out LIVE
    # fallback, but never let that display preference contaminate stored reasoning.
    assert live_commentary == ([commentary.content[0].text] if show_commentary else [])
    expected_live_reasoning = [] if ending == "commentary_only" else [summary]
    if not show_commentary:
        expected_live_reasoning.append(commentary.content[0].text)
    if ending != "commentary_only":
        expected_live_reasoning.append(analysis.content[0].text)
    assert live_reasoning == expected_live_reasoning
    assert live_text == (["Checked."] if ending == "final" else [])

    normalized = ResponsesApiTransport().normalize_response(response, issuer_kind="codex_backend")
    expected_reasoning = None if ending == "commentary_only" else f"{summary}\n\n{analysis.content[0].text}"
    assert normalized.reasoning == expected_reasoning
    assert normalized.content == ("Checked." if ending == "final" else "")
    assert normalized.finish_reason == {"tool": "tool_calls", "final": "stop", "commentary_only": "incomplete"}[ending]

    agent = AIAgent.__new__(AIAgent)
    agent.verbose_logging = False
    agent.context_compressor = None
    agent.reasoning_callback = agent.stream_delta_callback = agent._stream_callback = None
    agent._needs_thinking_reasoning_pad = lambda: False
    agent.show_commentary = show_commentary
    stored = agent._build_assistant_message(normalized, normalized.finish_reason)
    assert stored["reasoning"] == expected_reasoning
    assert stored.get("reasoning_content") == expected_reasoning
    expected_items = [
        {"type": "message", "role": "assistant", "id": item.id, "phase": item.phase,
         "status": item.status, "content": [{"type": "output_text", "text": item.content[0].text}]}
        for item in original if item.type == "message"
    ]
    assert stored["codex_message_items"] == expected_items
    assert agent._extract_codex_interim_visible_parts(stored) == live_commentary
    history = [{"role": "user", "content": "Check files."}, stored]
    if ending == "tool":
        history.append({"role": "tool", "tool_call_id": "call_check", "content": "Checked."})
    before_replay = deepcopy(history)
    replay = _chat_messages_to_responses_input(history, current_issuer_kind="codex_backend")
    replay_messages = [item for item in replay if item.get("type") == "message"]
    # Existing store=False replay policy drops message ids linked to encrypted
    # reasoning. Phase/status/text remain exact; no past rows are rewritten.
    expected_replay = expected_items if ending == "commentary_only" else [
        {key: value for key, value in item.items() if key != "id"} for item in expected_items
    ]
    assert replay_messages == expected_replay
    encrypted = [item for item in replay if item.get("type") == "reasoning"]
    assert [item["encrypted_content"] for item in encrypted] == ([] if ending == "commentary_only" else [reasoning.encrypted_content])
    assert output == original
    assert history == before_replay
