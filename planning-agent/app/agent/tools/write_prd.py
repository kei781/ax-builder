"""write_prd — persist the project's PRD.md to disk.

Per ARCHITECTURE §6.2 the markdown file is the SSoT. The tool simply writes
the content; validation/completeness evaluation is a separate concern
(Step 4).
"""
from __future__ import annotations

from pathlib import Path

from app.agent.tools.base import Tool, ToolSchema
from app.config import settings

SCHEMA: ToolSchema = {
    "type": "function",
    "function": {
        "name": "write_prd",
        "description": (
            "프로젝트의 PRD.md 파일을 생성하거나 전체를 덮어씁니다. "
            "내용은 완전한 마크다운 문서여야 하며, 기능 요구사항·사용자 플로우·"
            "비즈니스 로직 등 사용자가 결정해야 하는 영역을 포함해야 합니다. "
            "데이터 모델·포트·인증방식 같은 기술 결정은 당신이 자체적으로 채워주세요. "
            "대화가 충분히 구체화됐을 때 사용하세요. 매 턴마다 호출할 필요는 없습니다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "PRD.md의 전체 마크다운 내용",
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
    prd_path = project_dir / "PRD.md"
    prd_path.write_text(content, encoding="utf-8")
    return {
        "ok": True,
        "path": str(prd_path),
        "bytes": len(content.encode("utf-8")),
    }


TOOL = Tool(name="write_prd", schema=SCHEMA, fn=fn)
