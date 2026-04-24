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


@dataclass(frozen=True)
class ToolCtx:
    """Context passed to every tool handler.

    session_id/is_update_mode 추가(2026-04-24 §8 후속): write_prd의 UPDATE 모드
    방어책(기존 PRD 로드 + edit-distance guard + 자동 백업)을 구현하려면 도구가
    현재 세션과 라인(첫 빌드 vs 업데이트)을 알아야 한다. 기존 tool들은 이 값을
    무시하고 project_id만 쓰면 됨.
    """

    project_id: str
    session_id: str | None
    is_update_mode: bool


# Executor signature: (ctx, args dict) -> result dict
# The result is serialized as JSON and fed back to the LLM as a tool message.
ToolFn = Callable[[ToolCtx, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class Tool:
    name: str
    schema: ToolSchema
    fn: ToolFn
