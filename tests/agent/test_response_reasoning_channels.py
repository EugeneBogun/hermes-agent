"""Response progress must not turn public answer text into Thinking (#57077, #119716)."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from openai.types.chat import ChatCompletion

from agent.transports.chat_completions import ChatCompletionsTransport
from agent.turn_response_intake import normalize_model_response
from run_agent import AIAgent


def _intake(agent, response):
    return normalize_model_response(
        agent, response=response, messages=[], api_messages=[], conversation_history=[],
        api_call_count=1, api_duration=0.1, api_start_time=0.0, api_request_id="request-1",
        effective_task_id="task-1", turn_id="turn-1",
    )


@pytest.mark.parametrize("reasoning_field", [None, "reasoning", "reasoning_content", "reasoning_details", "inline"])
@pytest.mark.parametrize("delivery", ["progress", "block", "stream"])
@pytest.mark.parametrize("public_text", ["Public answer.\nSecond line.", None])
def test_intake_relays_complete_reasoning_without_relabeling_public_progress(
    reasoning_field, delivery, public_text,
):
    # Longer than the old 500-character preview: a snapshot must not erase its tail.
    reasoning = "Private reasoning.\n" * 40
    message = {"role": "assistant", "content": public_text}
    if reasoning_field == "reasoning_details":
        message[reasoning_field] = [{"type": "reasoning.text", "text": reasoning}]
    elif reasoning_field == "inline":
        message["content"] = f"<think>{reasoning}</think>{public_text or ''}"
    elif reasoning_field:
        message[reasoning_field] = reasoning
    response = ChatCompletion.model_validate({
        "id": "response-1", "object": "chat.completion", "created": 0, "model": "test-model",
        "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
    })
    progress, reasoning_deliveries = [], []
    transport = ChatCompletionsTransport()
    agent = AIAgent.__new__(AIAgent)
    agent.api_mode = "chat_completions"
    agent.quiet_mode = True
    agent.verbose_logging = False
    agent._get_transport = lambda: transport
    agent.tool_progress_callback = lambda *args, **kwargs: progress.append(args)
    agent.reasoning_callback = reasoning_deliveries.append if delivery != "progress" else None
    agent.stream_delta_callback = agent._stream_callback = None
    agent._delegate_depth = 0
    expected_reasoning = reasoning.strip() if reasoning_field == "inline" else reasoning
    expected_reasoning = expected_reasoning if reasoning_field else None
    expected_deliveries = []
    if delivery == "stream":
        agent.stream_delta_callback = lambda text: None
        if expected_reasoning:
            expected_deliveries = [expected_reasoning[:25], expected_reasoning[25:]]
            for delta in expected_deliveries:
                agent._fire_reasoning_delta(delta)
    elif expected_reasoning and delivery == "block":
        expected_deliveries = [expected_reasoning]

    # Reasoning deltas can arrive before any public answer delta. Intake must
    # not replace them with public content or re-send a cumulative snapshot.
    verdict = _intake(agent, response)
    assert verdict.action == "fallthrough"
    expected_progress = (
        [("reasoning.available", "_thinking", expected_reasoning, None)]
        if expected_reasoning and delivery == "progress" else []
    )
    assert progress == expected_progress
    stored = agent._build_assistant_message(verdict.assistant_message, verdict.finish_reason)
    assert stored["reasoning"] == expected_reasoning
    # Intake and storage share the same delivery receipt, so neither a streamed
    # response nor a completed block is re-sent when the message is materialized.
    agent._build_assistant_message(verdict.assistant_message, verdict.finish_reason)
    assert reasoning_deliveries == expected_deliveries
    assert stored["content"] == (public_text or "")

    # Child progress is intentionally a short status summary, not a reasoning snapshot.
    progress.clear()
    agent._delegate_depth = 1
    _intake(agent, response)
    content = verdict.assistant_message.content or ""
    first_line = content.replace("<think>", "").replace("</think>", "").strip().split("\n")[0][:80]
    assert progress == ([("_thinking", first_line)] if first_line else [])


@pytest.mark.parametrize("delivery", ["disabled", "provider-fallback"])
@pytest.mark.parametrize("reasoning_field", ["inline", "reasoning_content"])
@pytest.mark.parametrize("with_progress", [False, True])
def test_completed_reasoning_is_delivered_once_with_text_callbacks_installed(
    delivery, reasoning_field, with_progress,
):
    # Real SDK/HTTP -> request/retry -> intake -> storage, with no remote provider.
    reasoning = "Reasoned carefully.\n" * 40
    public_text = "Public answer."
    requests, progress, reasoning_deliveries, text_deliveries = [], [], [], []
    mode = "stream"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if not self.path.endswith("/chat/completions"):
                self.send_response(404)
                self.end_headers()
                return
            requests.append(request)
            if mode == "provider-fallback" and request.get("stream"):
                # A contentless SSE frame makes the real retry path disable streaming.
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b"data:\n\n")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if request.get("stream") else "application/json")
            self.end_headers()
            if request.get("stream"):
                for delta, finish in [({"reasoning_content": reasoning}, None), ({"content": public_text}, "stop")]:
                    chunk = {"id": "local-reasoning", "object": "chat.completion.chunk", "created": 0,
                             "model": "test-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                message = {"role": "assistant", "content": public_text}
                if reasoning_field == "inline":
                    message["content"] = f"<think>{reasoning}</think>{public_text}"
                else:
                    message[reasoning_field] = reasoning
                response = {"id": "local-reasoning", "object": "chat.completion", "created": 0,
                            "model": "test-model", "choices": [{"index": 0, "message": message, "finish_reason": "stop"}]}
                self.wfile.write(json.dumps(response).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        agent = AIAgent(
            api_key="local-test", base_url=f"http://127.0.0.1:{server.server_port}/v1",
            provider="custom", model="test-model", quiet_mode=True, max_iterations=2,
            skip_memory=True, skip_context_files=True, enabled_toolsets=[], save_trajectories=False,
            reasoning_callback=reasoning_deliveries.append, stream_delta_callback=text_deliveries.append,
            tool_progress_callback=(lambda *args, **kwargs: progress.append(args)) if with_progress else None,
        )
        first = agent.run_conversation("First response", system_message="Answer briefly.")
        assert first["final_response"] == public_text
        assert reasoning_deliveries == [reasoning]  # Normal streaming is not repeated at intake/storage.
        assert all(request.get("stream") for request in requests)
        requests.clear()
        reasoning_deliveries.clear()
        progress.clear()
        mode = delivery
        agent._disable_streaming = delivery == "disabled"

        result = agent.run_conversation("Next response", system_message="Answer briefly.")
        expected_reasoning = reasoning.strip() if reasoning_field == "inline" else reasoning
        assert result["final_response"] == public_text
        assert [request.get("stream", False) for request in requests] == (
            [False] if delivery == "disabled" else [True, False]
        )
        assert agent._disable_streaming is True
        assert reasoning_deliveries == [expected_reasoning]
        assert not [event for event in progress if event and event[0] == "reasoning.available"]
        assistant = next(message for message in reversed(result["messages"]) if message["role"] == "assistant")
        assert assistant["reasoning"] == expected_reasoning
        assert assistant["content"] == public_text
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
