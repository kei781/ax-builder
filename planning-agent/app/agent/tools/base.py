"""Tool base types.

A Tool is a pure async function plus an OpenAI-compatible JSON schema. The
registry maps tool names → (schema, fn). The agent loop uses the schemas to
tell the LLM what's available and dispatches calls through the registry.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

# Matches OpenAI chat-completions function-calling schema.
ToolSchema = dict[str, Any]

# Executor signature: (project_id, args dict) -> result dict
# The result is serialized as JSON and fed back to the LLM as a tool message.
ToolFn = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class Tool:
    name: str
    schema: ToolSchema
    fn: ToolFn
