"""search_memory — look up entries in the project_memory table.

Step 3 MVP: substring match on `key`. A future iteration can add vector
search once we introduce embeddings (ARCHITECTURE §5.2 reserves this).
"""
from __future__ import annotations

import json

from app.agent.tools.base import Tool, ToolSchema
from app.storage.db import connection

SCHEMA: ToolSchema = {
    "type": "function",
    "function": {
        "name": "search_memory",
        "description": (
            "이 프로젝트의 기억 저장소에서 관련 항목을 찾습니다. "
            "과거에 결정한 내용·사용자 선호·도메인 용어 등을 조회할 때 사용하세요. "
            "쿼리는 key에 대한 부분 문자열로 매칭됩니다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "검색어 (key에 포함된 문자열)",
                },
            },
            "required": ["query"],
        },
    },
}


async def fn(project_id: str, args: dict) -> dict:
    query: str = args.get("query", "") or ""
    with connection() as conn:
        rows = conn.execute(
            "SELECT key, value FROM project_memory WHERE project_id = ? AND key LIKE ? ORDER BY updated_at DESC LIMIT 20",
            (project_id, f"%{query}%"),
        ).fetchall()

    matches = []
    for r in rows:
        try:
            value = json.loads(r["value"])
        except (json.JSONDecodeError, TypeError):
            value = r["value"]
        matches.append({"key": r["key"], "value": value})
    return {"ok": True, "matches": matches}


TOOL = Tool(name="search_memory", schema=SCHEMA, fn=fn)
