"""Event emission for Building Agent.

All events are written as a single JSON line on stderr. The NestJS
BuildingRunner reads stderr line-by-line, parses JSON, and fans events out
to the frontend via BuildGateway.

The schema matches `orchestrator/src/websocket/events.ts` (AgentEvent).
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any


def emit(
    event_type: str,
    *,
    project_id: str,
    session_id: str | None = None,
    build_id: str | None = None,
    phase: str | None = None,
    progress_percent: int | None = None,
    payload: Any = None,
) -> None:
    event: dict[str, Any] = {
        "agent": "building",
        "project_id": project_id,
        "event_type": event_type,
        "at": int(time.time() * 1000),
    }
    if session_id:
        event["session_id"] = session_id
    if build_id:
        event["build_id"] = build_id
    if phase:
        event["phase"] = phase
    if progress_percent is not None:
        event["progress_percent"] = progress_percent
    if payload is not None:
        event["payload"] = payload

    print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)


def log(message: str, **meta: Any) -> None:
    """Non-JSON human-readable line — useful during debugging. These still
    hit stderr and show up in orchestrator logs but are tagged so the
    event parser skips them."""
    if meta:
        print(f"[ba-log] {message} | {meta}", file=sys.stderr, flush=True)
    else:
        print(f"[ba-log] {message}", file=sys.stderr, flush=True)
