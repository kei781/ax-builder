"""Tool registry — single source for schemas and dispatch.

Register each tool module here. `get_schemas()` returns the list passed to
the LLM; `dispatch()` executes a named tool with parsed args.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.agent.tools.base import Tool
from app.agent.tools.propose_handoff import TOOL as PROPOSE_HANDOFF
from app.agent.tools.search_memory import TOOL as SEARCH_MEMORY
from app.agent.tools.update_memory import TOOL as UPDATE_MEMORY
from app.agent.tools.write_design import TOOL as WRITE_DESIGN
from app.agent.tools.write_prd import TOOL as WRITE_PRD

log = logging.getLogger(__name__)

_REGISTRY: dict[str, Tool] = {
    t.name: t
    for t in (
        WRITE_PRD,
        WRITE_DESIGN,
        SEARCH_MEMORY,
        UPDATE_MEMORY,
        PROPOSE_HANDOFF,
    )
}


def get_schemas() -> list[dict]:
    return [tool.schema for tool in _REGISTRY.values()]


async def dispatch(project_id: str, name: str, args_json: str) -> dict[str, Any]:
    tool = _REGISTRY.get(name)
    if tool is None:
        return {"ok": False, "error": f"unknown tool: {name}"}
    try:
        args = json.loads(args_json) if args_json else {}
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"invalid tool args: {e}"}
    try:
        return await tool.fn(project_id, args)
    except Exception as e:  # noqa: BLE001 — surface to LLM, don't crash loop
        log.exception("tool %s failed for project=%s", name, project_id)
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
