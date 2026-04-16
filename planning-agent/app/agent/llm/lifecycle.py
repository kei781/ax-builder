"""Idle timeout wrapper — auto-unload models from VRAM after inactivity.

For `openai_compat` backend these are effectively no-ops (cloud models have
no residency). For `ollama`, the timer triggers `backend.stop(slot)` to free
VRAM so other slots can load.
"""
from __future__ import annotations

import asyncio
import logging

from app.agent.llm.adapter import backend
from app.agent.llm.slots import SlotConfig, get_slot_config
from app.config import settings

log = logging.getLogger(__name__)

_idle_tasks: dict[str, asyncio.Task] = {}


def _idle_seconds() -> float:
    return settings.IDLE_TIMEOUT_MS / 1000.0


async def _idle_unload(slot: str) -> None:
    try:
        await asyncio.sleep(_idle_seconds())
        config = get_slot_config(slot)
        result = await backend.stop(config)
        log.info("idle timeout — stopped %s (%s): %s", slot, config.model, result)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001 — we swallow so one slot doesn't crash others
        log.warning("idle stop failed for %s: %s", slot, e)
    finally:
        _idle_tasks.pop(slot, None)


def _reset_idle_timer(slot: str) -> None:
    existing = _idle_tasks.get(slot)
    if existing and not existing.done():
        existing.cancel()
    _idle_tasks[slot] = asyncio.create_task(_idle_unload(slot))


async def health(slot: str) -> dict:
    return await backend.health(get_slot_config(slot))


async def start(slot: str) -> dict:
    config = get_slot_config(slot)
    result = await backend.start(config)
    _reset_idle_timer(slot)
    return result


async def ask_stream(slot: str, messages, **options):
    """Stream tokens for a given slot. Auto-starts the model if needed.

    Usage:
        async for token in lifecycle.ask_stream('chat', [...messages]):
            ...
    """
    config = get_slot_config(slot)

    status = await backend.health(config)
    if not status.get("loaded"):
        log.info("auto-starting %s (%s)", slot, config.model)
        await backend.start(config)

    try:
        async for token in backend.ask_stream(config, messages, **options):
            yield token
    finally:
        _reset_idle_timer(slot)


async def ask_stream_events(slot: str, messages, tools=None, **options):
    """Typed event stream for the tool-calling agent loop.

    Wraps the backend's `ask_stream_events` with the same auto-start +
    idle-timer-reset semantics as `ask_stream`.
    """
    config = get_slot_config(slot)

    status = await backend.health(config)
    if not status.get("loaded"):
        log.info("auto-starting %s (%s)", slot, config.model)
        await backend.start(config)

    try:
        async for event in backend.ask_stream_events(
            config, messages, tools=tools, **options
        ):
            yield event
    finally:
        _reset_idle_timer(slot)


async def stop(slot: str) -> dict:
    existing = _idle_tasks.pop(slot, None)
    if existing and not existing.done():
        existing.cancel()
    return await backend.stop(get_slot_config(slot))


def shutdown() -> None:
    for slot, task in list(_idle_tasks.items()):
        if not task.done():
            task.cancel()
        _idle_tasks.pop(slot, None)
