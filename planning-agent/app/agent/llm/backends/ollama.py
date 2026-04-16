"""Ollama backend for local models (Mac Studio path).

Ported from kei781/agent-model-mcp (Node → Python). Preserves the original
health/start/stop semantics so lifecycle.py can manage VRAM residency.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx

from app.agent.llm.slots import SlotConfig
from app.config import settings


def _base_url() -> str:
    return settings.OLLAMA_BASE_URL


class OllamaBackend:
    name = "ollama"

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_S)

    async def health(self, slot: SlotConfig) -> dict[str, Any]:
        try:
            tags = await self._client.get(f"{_base_url()}/api/tags", timeout=5)
            if tags.status_code != 200:
                return {
                    "ok": False,
                    "loaded": False,
                    "detail": f"Ollama unreachable: {tags.status_code}",
                }
            tag_data = tags.json()
            pulled = any(
                m.get("name") in (slot.model, f"{slot.model}:latest")
                for m in tag_data.get("models", [])
            )
            if not pulled:
                return {
                    "ok": False,
                    "loaded": False,
                    "detail": f"model {slot.model} not pulled",
                }

            ps = await self._client.get(f"{_base_url()}/api/ps", timeout=5)
            if ps.status_code != 200:
                return {"ok": True, "loaded": False, "detail": "pulled but cannot check load status"}
            ps_data = ps.json()
            loaded = any(
                m.get("name") in (slot.model, f"{slot.model}:latest")
                for m in ps_data.get("models", [])
            )
            return {
                "ok": True,
                "loaded": loaded,
                "detail": f"{slot.model} {'loaded' if loaded else 'not loaded'} in VRAM",
            }
        except httpx.HTTPError as e:
            return {"ok": False, "loaded": False, "detail": f"Ollama connection failed: {e}"}

    async def start(self, slot: SlotConfig) -> dict[str, Any]:
        try:
            res = await self._client.post(
                f"{_base_url()}/api/generate",
                json={
                    "model": slot.model,
                    "prompt": "",
                    "keep_alive": "5m",
                    "stream": False,
                },
                timeout=120,
            )
            if res.status_code != 200:
                return {"ok": False, "detail": f"Ollama start {res.status_code}: {res.text}"}
            return {"ok": True, "detail": f"{slot.model} loaded into VRAM"}
        except httpx.HTTPError as e:
            return {"ok": False, "detail": f"Failed to start: {e}"}

    async def stop(self, slot: SlotConfig) -> dict[str, Any]:
        try:
            res = await self._client.post(
                f"{_base_url()}/api/generate",
                json={"model": slot.model, "prompt": "", "keep_alive": 0, "stream": False},
                timeout=30,
            )
            if res.status_code != 200:
                return {"ok": False, "detail": f"Ollama stop {res.status_code}: {res.text}"}
            return {"ok": True, "detail": f"{slot.model} unloaded"}
        except httpx.HTTPError as e:
            return {"ok": False, "detail": f"Failed to stop: {e}"}

    async def ask_stream(
        self,
        slot: SlotConfig,
        messages: Sequence[dict[str, Any]],
        **_options: Any,
    ) -> AsyncIterator[str]:
        """Stream tokens via /api/chat."""
        async with self._client.stream(
            "POST",
            f"{_base_url()}/api/chat",
            json={"model": slot.model, "messages": list(messages), "stream": True},
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = chunk.get("message", {}).get("content")
                if content:
                    yield content

    async def ask_stream_events(
        self,
        slot: SlotConfig,
        messages: Sequence[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        **_options: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        """Tool-call streaming for Ollama is Step-TBD.

        When Mac Studio lands we'll wire Ollama's native `tools` parameter
        (Llama 3.1+, Qwen2.5-Instruct support it). For now, fall back to a
        plain stream if no tools are requested; raise otherwise so the
        operator notices the gap early.
        """
        if tools:
            raise NotImplementedError(
                "Ollama tool-calling is not wired yet. Use LLM_BACKEND=openai_compat "
                "until the Mac Studio integration lands."
            )
        async for text in self.ask_stream(slot, messages):
            yield {"type": "text", "content": text}
        yield {"type": "finish", "reason": "stop"}
