"""Minimal LLM client — one-shot synchronous calls to Gemini via the
OpenAI-compatible endpoint.

Building Agent doesn't need streaming (it's a batch process), so we skip
the async complexity of the Planning Agent's adapter. The `slot` concept
is preserved so that when Mac Studio lands we can reroute to local models
by changing `settings.SLOT_*` — see agent-model-mcp for the full pattern.
"""
from __future__ import annotations

import json
import re
from typing import Any

from openai import OpenAI

from config import settings

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(
            base_url=settings.OPENAI_COMPAT_BASE_URL,
            api_key=settings.OPENAI_COMPAT_API_KEY,
            timeout=120,
        )
    return _client


def ask(model: str, messages: list[dict[str, Any]], **options: Any) -> str:
    """One-shot chat completion. Returns the assistant's text response."""
    resp = _get_client().chat.completions.create(
        model=model,
        messages=messages,
        **options,
    )
    content = resp.choices[0].message.content or ""
    return content


def ask_json(model: str, messages: list[dict[str, Any]], **options: Any) -> Any:
    """Call the model expecting a JSON response; strip markdown fences if any."""
    text = ask(model, messages, **options)
    return _parse_json_strict(text)


def _parse_json_strict(text: str) -> Any:
    """Best-effort JSON extraction: handle ```json``` fences or leading text."""
    stripped = text.strip()
    # Strip ```json ... ``` fences
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", stripped, re.DOTALL)
    if fence:
        stripped = fence.group(1).strip()
    # If the model prepended prose, try to find the first [ or { and slice
    for opener, closer in (("[", "]"), ("{", "}")):
        start = stripped.find(opener)
        end = stripped.rfind(closer)
        if start != -1 and end != -1 and end > start:
            candidate = stripped[start : end + 1]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue
    return json.loads(stripped)
