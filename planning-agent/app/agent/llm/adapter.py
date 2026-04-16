"""Backend selector — picks which backend class to use based on LLM_BACKEND env.

Call sites (agent loop, summarizer, evaluator) import `backend` from here and
treat it as a single opaque object. Swapping `LLM_BACKEND=ollama` in .env is
the only change required to move off the cloud.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.agent.llm.backends.ollama import OllamaBackend
from app.agent.llm.backends.openai_compat import OpenAICompatBackend
from app.agent.llm.slots import SlotConfig
from app.config import settings


@runtime_checkable
class LLMBackend(Protocol):
    name: str

    async def health(self, slot: SlotConfig) -> dict: ...
    async def start(self, slot: SlotConfig) -> dict: ...
    async def stop(self, slot: SlotConfig) -> dict: ...
    def ask_stream(self, slot: SlotConfig, messages, **options): ...


_REGISTRY = {
    "openai_compat": OpenAICompatBackend,
    "ollama": OllamaBackend,
}


def _pick_backend() -> LLMBackend:
    cls = _REGISTRY.get(settings.LLM_BACKEND)
    if cls is None:
        raise RuntimeError(
            f"Unknown LLM_BACKEND '{settings.LLM_BACKEND}'. "
            f"Available: {', '.join(_REGISTRY.keys())}"
        )
    return cls()


backend: LLMBackend = _pick_backend()
