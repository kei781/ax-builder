"""Event envelope shared between Planning Agent and the orchestrator.

Mirrors `orchestrator/src/websocket/events.ts` — same field names, same
event types. Python uses snake_case natively, TypeScript was authored to
match, so the wire representation is identical.
"""
from __future__ import annotations

import time
from typing import Any, Literal, TypedDict

AgentSource = Literal["planning", "building"]

AgentEventType = Literal[
    "progress",
    "log",
    "error",
    "user_prompt",
    "phase_start",
    "phase_end",
    "token",
    "tool_call",
    "tool_result",
    "completion",
]


class AgentEvent(TypedDict, total=False):
    agent: AgentSource
    project_id: str
    session_id: str
    build_id: str
    event_type: AgentEventType
    phase: str
    progress_percent: int
    payload: Any
    at: int


def make_event(
    event_type: AgentEventType,
    project_id: str,
    *,
    session_id: str | None = None,
    phase: str | None = None,
    progress_percent: int | None = None,
    payload: Any = None,
) -> AgentEvent:
    event: AgentEvent = {
        "agent": "planning",
        "project_id": project_id,
        "event_type": event_type,
        "at": int(time.time() * 1000),
    }
    if session_id:
        event["session_id"] = session_id
    if phase:
        event["phase"] = phase
    if progress_percent is not None:
        event["progress_percent"] = progress_percent
    if payload is not None:
        event["payload"] = payload
    return event
