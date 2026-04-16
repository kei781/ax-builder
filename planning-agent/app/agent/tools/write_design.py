"""write_design — persist the project's DESIGN.md to disk."""
from __future__ import annotations

from pathlib import Path

from app.agent.tools.base import Tool, ToolSchema
from app.config import settings

SCHEMA: ToolSchema = {
    "type": "function",
    "function": {
        "name": "write_design",
        "description": (
            "프로젝트의 DESIGN.md 파일을 생성하거나 전체를 덮어씁니다. "
            "컬러·폰트·레이아웃·컴포넌트 스타일 같은 디자인 시스템 사양을 담습니다. "
            "PRD가 결정된 후에 호출하는 것을 권장합니다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "DESIGN.md의 전체 마크다운 내용",
                },
            },
            "required": ["content"],
        },
    },
}


async def fn(project_id: str, args: dict) -> dict:
    content: str = args.get("content", "") or ""
    if not content.strip():
        return {"ok": False, "error": "content is empty"}

    project_dir = Path(settings.PROJECTS_BASE_DIR) / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    design_path = project_dir / "DESIGN.md"
    design_path.write_text(content, encoding="utf-8")
    return {
        "ok": True,
        "path": str(design_path),
        "bytes": len(content.encode("utf-8")),
    }


TOOL = Tool(name="write_design", schema=SCHEMA, fn=fn)
