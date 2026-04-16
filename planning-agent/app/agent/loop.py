"""Agent loop with tool calling.

One call to `run_turn()` drives up to MAX_TOOL_ITERATIONS rounds of
(LLM stream → tool calls → tool execution → feed results back). Text
deltas stream out as `token` events; tool invocations emit a
`tool_call`/`tool_result` pair; the final assistant text yields as
`completion`.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Sequence
from typing import Any

from app.agent.llm import lifecycle
from app.agent.system_prompt import PLANNING_SYSTEM_PROMPT
from app.agent.tools import registry
from app.config import settings
from app.transport.events import AgentEvent, make_event

log = logging.getLogger(__name__)


def _build_initial_messages(
    history: Sequence[dict[str, Any]],
    new_user_message: str,
) -> list[dict[str, Any]]:
    """Compose the starting chat-completions message array."""
    msgs: list[dict[str, Any]] = [
        {"role": "system", "content": PLANNING_SYSTEM_PROMPT}
    ]
    # Defensive truncation — orchestrator enforces the limit too.
    recent = list(history)[-settings.MAX_HISTORY_MESSAGES :]
    for m in recent:
        role = m.get("role")
        content = m.get("content") or ""
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": new_user_message})
    return msgs


def _accumulate_tool_call(
    acc: dict[str, dict[str, Any]],
    index_to_key: dict[int, str],
    event: dict[str, Any],
) -> None:
    """Merge a streaming tool_call_delta into our accumulator.

    We key by tool-call ``id`` rather than ``index`` because some
    OpenAI-compatible endpoints (observed with Gemini's v1beta compat)
    emit parallel tool calls with duplicate index=0, which used to make
    us concatenate two different tool calls into one slot.

    ``index_to_key`` maps the streaming ``index`` field to the stable ``id``
    key so that subsequent argument-only deltas (which may lack ``id``)
    route back to the right slot.
    """
    id_ = event.get("id")
    idx = event.get("index", 0)
    name = event.get("name")
    arguments = event.get("arguments")

    if id_:
        key = id_
        index_to_key[idx] = key
    else:
        key = index_to_key.get(idx)
        if key is None:
            # No id yet and no prior mapping — synthesize a temporary key.
            key = f"__idx_{idx}"
            index_to_key[idx] = key

    slot = acc.setdefault(
        key,
        {"id": id_, "type": "function", "function": {"name": "", "arguments": ""}},
    )
    if id_ and not slot["id"]:
        slot["id"] = id_
    if name:
        slot["function"]["name"] += name
    if arguments:
        slot["function"]["arguments"] += arguments


def _flatten_tool_calls(acc: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Return tool calls in insertion order (Python dicts preserve it)."""
    return list(acc.values())


async def run_turn(
    project_id: str,
    session_id: str | None,
    history: Sequence[dict[str, Any]],
    new_user_message: str,
) -> AsyncIterator[AgentEvent]:
    """Execute one conversational turn, yielding AgentEvents as they occur.

    Event sequence:
      1. one `progress` ({phase: 'thinking'})
      2. For each iteration until no tool calls:
         - stream `token` events with text deltas
         - on tool calls: `tool_call` per invocation, then execute, then `tool_result`
      3. one `completion` event with the final assistant text

    Errors yield a single `error` event and stop.
    """
    messages = _build_initial_messages(history, new_user_message)
    tool_schemas = registry.get_schemas()

    yield make_event(
        "progress",
        project_id,
        session_id=session_id,
        phase="thinking",
        progress_percent=0,
        payload={"detail": "thinking..."},
    )

    final_text_parts: list[str] = []

    for iteration in range(settings.MAX_TOOL_ITERATIONS):
        text_buf: list[str] = []
        tool_calls_acc: dict[str, dict[str, Any]] = {}
        index_to_key: dict[int, str] = {}
        finish_reason: str | None = None

        try:
            async for ev in lifecycle.ask_stream_events(
                "chat", messages, tools=tool_schemas
            ):
                kind = ev.get("type")
                if kind == "text":
                    content = ev.get("content", "")
                    text_buf.append(content)
                    yield make_event(
                        "token",
                        project_id,
                        session_id=session_id,
                        payload={"delta": content},
                    )
                elif kind == "tool_call_delta":
                    _accumulate_tool_call(tool_calls_acc, index_to_key, ev)
                elif kind == "finish":
                    finish_reason = ev.get("reason")
        except Exception as e:  # noqa: BLE001
            log.exception("LLM stream failed for project=%s", project_id)
            yield make_event(
                "error",
                project_id,
                session_id=session_id,
                payload={"message": str(e), "kind": e.__class__.__name__},
            )
            return

        assistant_text = "".join(text_buf)
        final_text_parts.append(assistant_text)
        tool_calls = _flatten_tool_calls(tool_calls_acc)

        # No tool calls? We're done.
        if not tool_calls:
            break

        # Append the assistant turn (including tool_calls) to messages so the
        # next LLM call sees the decision.
        messages.append(
            {
                "role": "assistant",
                "content": assistant_text or None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": tc["function"]["arguments"],
                        },
                    }
                    for tc in tool_calls
                ],
            }
        )

        # Execute each tool and emit events.
        for tc in tool_calls:
            name = tc["function"]["name"]
            args_raw = tc["function"]["arguments"]
            call_id = tc["id"]

            yield make_event(
                "tool_call",
                project_id,
                session_id=session_id,
                payload={"id": call_id, "name": name, "arguments": args_raw},
            )

            result = await registry.dispatch(project_id, name, args_raw)

            yield make_event(
                "tool_result",
                project_id,
                session_id=session_id,
                payload={"id": call_id, "name": name, "result": result},
            )

            # Feed the result back as a tool message for the next iteration.
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": _tool_result_as_text(result),
                }
            )

        if finish_reason and finish_reason not in ("tool_calls", "function_call"):
            # LLM signaled end-of-stream for a non-tool reason; treat as done.
            break
    else:
        # Loop exhausted without natural termination — surface as error so
        # orchestrator can present it to the user.
        yield make_event(
            "error",
            project_id,
            session_id=session_id,
            payload={
                "message": (
                    f"max tool iterations reached "
                    f"({settings.MAX_TOOL_ITERATIONS}); forcing completion"
                ),
                "kind": "ToolLoopLimit",
            },
        )
        return

    full_text = "".join(final_text_parts).strip()

    # Guard: if the LLM produced no text and no tool calls in the final
    # iteration, something went wrong (Gemini sometimes returns empty
    # responses). Surface as an error so the user knows to retry.
    if not full_text:
        log.warning("LLM produced empty response for project=%s", project_id)
        yield make_event(
            "error",
            project_id,
            session_id=session_id,
            payload={
                "message": "에이전트가 빈 응답을 반환했습니다. 다시 시도해주세요.",
                "kind": "EmptyResponse",
            },
        )
        return

    yield make_event(
        "completion",
        project_id,
        session_id=session_id,
        progress_percent=100,
        payload={"role": "assistant", "content": full_text},
    )


def _tool_result_as_text(result: Any) -> str:
    """Tool messages in the chat-completions API must be strings."""
    import json

    try:
        return json.dumps(result, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(result)
