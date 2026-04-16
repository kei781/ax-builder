"""Planning Agent entrypoint.

FastAPI gives us HTTP health + slot listing. Socket.IO mounted at `/socket.io`
handles the chat:turn ↔ agent:event traffic with the orchestrator.

Run (dev):
    uvicorn app.main:app --host 127.0.0.1 --port 4100 --reload
"""
from __future__ import annotations

import logging

import socketio
from fastapi import FastAPI

from app.agent.llm import lifecycle
from app.agent.llm.slots import list_slots
from app.config import settings
from app.transport.sio_handlers import register_handlers

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("planning-agent")

# Socket.IO server (AsyncServer). cors_allowed_origins='*' is fine because
# this service is bound to localhost by default (PLANNING_AGENT_HOST).
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)
register_handlers(sio)

fastapi_app = FastAPI(title="ax-planning-agent", version="0.1.0")


@fastapi_app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "backend": settings.LLM_BACKEND,
        "slots": list_slots(),
    }


@fastapi_app.get("/slots/{slot}/health")
async def slot_health(slot: str) -> dict:
    return await lifecycle.health(slot)


@fastapi_app.on_event("shutdown")
async def _shutdown() -> None:  # pragma: no cover
    log.info("shutdown: cancelling idle timers")
    lifecycle.shutdown()


# ASGI composition: Socket.IO on top of FastAPI.
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
