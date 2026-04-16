"""Socket.IO event handlers — receive `chat:turn` from the orchestrator, run
the agent loop, and stream events back on the same session.
"""
from __future__ import annotations

import logging
from typing import Any

import socketio

from app.agent.loop import run_turn

log = logging.getLogger(__name__)


def register_handlers(sio: socketio.AsyncServer) -> None:
    @sio.event
    async def connect(sid: str, _environ: dict, auth: dict | None = None) -> None:
        log.info("orchestrator connected: sid=%s auth=%s", sid, bool(auth))

    @sio.event
    async def disconnect(sid: str) -> None:
        log.info("orchestrator disconnected: sid=%s", sid)

    @sio.on("chat:turn")
    async def on_chat_turn(sid: str, data: dict[str, Any]) -> None:
        """Payload shape (from orchestrator):
            {
              project_id: str,
              session_id: str | None,
              history: [ { role, content }, ... ],
              user_message: str
            }

        Events stream back on the same sid with `agent:event` name.
        """
        project_id = data.get("project_id")
        session_id = data.get("session_id")
        history = data.get("history", [])
        user_message = data.get("user_message", "")

        if not project_id or not user_message:
            await sio.emit(
                "agent:event",
                {
                    "agent": "planning",
                    "project_id": project_id or "",
                    "event_type": "error",
                    "payload": {"message": "project_id and user_message are required"},
                },
                to=sid,
            )
            return

        log.info(
            "chat:turn sid=%s project=%s history=%d msg_len=%d",
            sid,
            project_id,
            len(history),
            len(user_message),
        )

        async for event in run_turn(project_id, session_id, history, user_message):
            await sio.emit("agent:event", event, to=sid)
