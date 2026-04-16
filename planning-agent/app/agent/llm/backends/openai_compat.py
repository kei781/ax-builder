"""OpenAI-compatible backend — works for Gemini's OpenAI endpoint, OpenRouter,
native OpenAI, and any other service that speaks the OpenAI chat API.

Stateless — `health`, `start`, `stop` are no-ops because nothing to warm up.

Two streaming APIs:
  - `ask_stream`  : text-only stream, yields string chunks.
  - `ask_stream_events` : richer stream that yields typed events for agent loops
    with tool calling (text deltas, tool_call deltas, finish).
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any

from openai import AsyncOpenAI

from app.agent.llm.slots import SlotConfig
from app.config import settings


class OpenAICompatBackend:
    name = "openai_compat"

    def __init__(self) -> None:
        self._client = AsyncOpenAI(
            base_url=settings.OPENAI_COMPAT_BASE_URL,
            api_key=settings.OPENAI_COMPAT_API_KEY,
            timeout=settings.LLM_TIMEOUT_S,
        )

    async def health(self, _slot: SlotConfig) -> dict[str, Any]:
        # Cloud models are always "loaded" — no warm-up state to check.
        return {"ok": True, "loaded": True, "detail": "cloud (always loaded)"}

    async def start(self, _slot: SlotConfig) -> dict[str, Any]:
        return {"ok": True, "detail": "no-op for cloud backend"}

    async def stop(self, _slot: SlotConfig) -> dict[str, Any]:
        return {"ok": True, "detail": "no-op for cloud backend"}

    async def ask_stream(
        self,
        slot: SlotConfig,
        messages: Sequence[dict[str, Any]],
        **options: Any,
    ) -> AsyncIterator[str]:
        """Stream text tokens. For non-tool use cases (summarizer, eval)."""
        stream = await self._client.chat.completions.create(
            model=slot.model,
            messages=list(messages),
            stream=True,
            **options,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", None)
            if text:
                yield text

    async def ask_stream_events(
        self,
        slot: SlotConfig,
        messages: Sequence[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        **options: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream typed events for the tool-calling agent loop.

        Event shapes (all include 'type'):
          {type: 'text', content: str}
          {type: 'tool_call_delta', index: int, id?: str, name?: str, arguments?: str}
          {type: 'finish', reason: str}
        """
        call_kwargs: dict[str, Any] = {
            "model": slot.model,
            "messages": list(messages),
            "stream": True,
            **options,
        }
        if tools:
            call_kwargs["tools"] = tools

        stream = await self._client.chat.completions.create(**call_kwargs)
        async for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            text = getattr(delta, "content", None)
            if text:
                yield {"type": "text", "content": text}

            tc_list = getattr(delta, "tool_calls", None)
            if tc_list:
                for tc in tc_list:
                    event: dict[str, Any] = {
                        "type": "tool_call_delta",
                        "index": getattr(tc, "index", 0),
                    }
                    if getattr(tc, "id", None):
                        event["id"] = tc.id
                    fn = getattr(tc, "function", None)
                    if fn is not None:
                        name = getattr(fn, "name", None)
                        if name:
                            event["name"] = name
                        args = getattr(fn, "arguments", None)
                        if args:
                            event["arguments"] = args
                    yield event

            if choice.finish_reason:
                yield {"type": "finish", "reason": choice.finish_reason}
