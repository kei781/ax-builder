"""update_memory — upsert a key/value pair into project_memory.

The orchestrator's entity has UNIQUE(project_id, key); we rely on SQLite's
ON CONFLICT clause to make this an idempotent upsert.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from app.agent.tools.base import Tool, ToolSchema
from app.storage.db import connection

SCHEMA: ToolSchema = {
    "type": "function",
    "function": {
        "name": "update_memory",
        "description": (
            "이 프로젝트의 기억 저장소에 key/value를 저장합니다. "
            "중요한 결정, 사용자 선호, 반복 참조가 필요한 도메인 용어를 저장하세요. "
            "같은 key로 다시 호출하면 값이 덮어써집니다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "기억 항목의 키 (예: 'target_users', 'core_feature_1')",
                },
                "value": {
                    "description": "저장할 값 — 문자열·객체·배열 모두 가능",
                },
            },
            "required": ["key", "value"],
        },
    },
}


async def fn(project_id: str, args: dict) -> dict:
    key: str = args.get("key", "") or ""
    value: Any = args.get("value")
    if not key:
        return {"ok": False, "error": "key is required"}

    serialized = json.dumps(value, ensure_ascii=False)
    row_id = str(uuid.uuid4())
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO project_memory (id, project_id, key, value, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
            """,
            (row_id, project_id, key, serialized),
        )
    return {"ok": True, "key": key}


TOOL = Tool(name="update_memory", schema=SCHEMA, fn=fn)
