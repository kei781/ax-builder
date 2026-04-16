"""Slot registry — maps role names (`chat`, `summarize`, ...) to model IDs.

Ported from https://github.com/kei781/agent-model-mcp but simplified: we keep
exactly the 4 slots the Planning Agent needs and expose a single lookup API.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.config import settings

VALID_SLOTS = ("chat", "summarize", "eval", "tool_arg")
SlotName = str  # Literal would be nicer but keeps this module import-light


@dataclass(frozen=True)
class SlotConfig:
    slot: SlotName
    model: str


_SLOT_MAP: dict[SlotName, str] = {
    "chat": settings.SLOT_CHAT,
    "summarize": settings.SLOT_SUMMARIZE,
    "eval": settings.SLOT_EVAL,
    "tool_arg": settings.SLOT_TOOL_ARG,
}


def get_slot_config(slot: SlotName) -> SlotConfig:
    if slot not in VALID_SLOTS:
        raise ValueError(
            f"Unknown slot '{slot}'. Available: {', '.join(VALID_SLOTS)}"
        )
    model = _SLOT_MAP.get(slot)
    if not model:
        raise RuntimeError(
            f"Slot '{slot}' is not configured. Set SLOT_{slot.upper()} in .env"
        )
    return SlotConfig(slot=slot, model=model)


def list_slots() -> list[dict[str, object]]:
    return [
        {
            "slot": s,
            "model": _SLOT_MAP.get(s, "(not configured)"),
            "configured": bool(_SLOT_MAP.get(s)),
        }
        for s in VALID_SLOTS
    ]
