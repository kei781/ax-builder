"""propose_handoff — Planning Agent's self-evaluation of PRD/DESIGN maturity.

When the agent thinks the spec is ready (or nearly so), it calls this tool
with a structured payload. The tool:
  1. Writes a row to the `handoffs` table.
  2. If minimum criteria are met (all completeness >= 0.6 AND no unresolved
     questions), atomically transitions projects.state: 'planning' → 'plan_ready'.

The orchestrator picks up the transition via the tool_result event and
notifies the frontend. The user then clicks "빌드 시작" to advance to
'building' (ARCHITECTURE §6.3, §7.2).
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from app.agent.tools.base import Tool, ToolSchema
from app.config import settings
from app.storage.db import connection

log = logging.getLogger(__name__)

MIN_COMPLETENESS = 0.6
SUFFICIENT_COMPLETENESS = 0.85
COMPLETENESS_KEYS = (
    "problem_definition",
    "feature_list",
    "user_flow",
    "feasibility",
    "user_experience",
)

SCHEMA: ToolSchema = {
    "type": "function",
    "function": {
        "name": "propose_handoff",
        "description": (
            "PRD/DESIGN 문서가 충분히 완성됐다고 판단될 때 호출하여, "
            "다음 단계(Building)로의 이관을 제안합니다. "
            "completeness 5개 항목이 모두 0.6 이상이고 unresolved_questions가 "
            "비어있을 때만 plan_ready 상태로 전이됩니다. "
            "완성도가 낮거나 질문이 남아있으면 rejected로 반환되며, 대화를 "
            "이어가서 보강 후 다시 호출하세요. "
            "이 도구를 호출하기 전에 반드시 write_prd 로 최신 PRD.md가 저장돼 있어야 합니다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "completeness": {
                    "type": "object",
                    "description": "각 항목을 0.0~1.0 사이 실수로 자체 평가",
                    "properties": {
                        "problem_definition": {"type": "number"},
                        "feature_list": {"type": "number"},
                        "user_flow": {"type": "number"},
                        "feasibility": {"type": "number"},
                        "user_experience": {"type": "number"},
                    },
                    "required": list(COMPLETENESS_KEYS),
                },
                "unresolved_questions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "사용자에게 더 물어봐야 할 항목. 비어있어야 handoff 가능.",
                },
                "assumptions_made": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "에이전트가 임의로 결정한 항목. 사용자 검토용.",
                },
                "tech_constraints": {
                    "type": "object",
                    "description": "강제 기술 제약 (storage, runtime 등)",
                    "additionalProperties": {"type": "string"},
                },
            },
            "required": [
                "completeness",
                "unresolved_questions",
                "assumptions_made",
                "tech_constraints",
            ],
        },
    },
}


def _validate(args: dict[str, Any]) -> tuple[bool, str | None]:
    comp = args.get("completeness") or {}
    if not isinstance(comp, dict):
        return False, "completeness must be an object"
    for key in COMPLETENESS_KEYS:
        val = comp.get(key)
        if not isinstance(val, (int, float)):
            return False, f"completeness.{key} must be a number"
        if val < 0 or val > 1:
            return False, f"completeness.{key} out of range [0, 1]"

    for field, expected in (
        ("unresolved_questions", list),
        ("assumptions_made", list),
        ("tech_constraints", dict),
    ):
        if not isinstance(args.get(field), expected):
            return False, f"{field} must be {expected.__name__}"

    return True, None


async def fn(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    ok, err = _validate(args)
    if not ok:
        return {"ok": False, "accepted": False, "error": err}

    completeness: dict[str, float] = {
        k: float(args["completeness"][k]) for k in COMPLETENESS_KEYS
    }
    min_score = min(completeness.values())
    meets_minimum = min_score >= MIN_COMPLETENESS
    is_sufficient = min_score >= SUFFICIENT_COMPLETENESS
    has_unresolved = len(args["unresolved_questions"]) > 0
    accepted = meets_minimum and not has_unresolved

    # Ensure PRD/DESIGN files exist — handoff without artifacts is incoherent.
    project_dir = Path(settings.PROJECTS_BASE_DIR) / project_id
    prd_path = project_dir / "PRD.md"
    design_path = project_dir / "DESIGN.md"
    if not prd_path.exists():
        return {
            "ok": False,
            "accepted": False,
            "error": "PRD.md가 아직 생성되지 않았습니다. write_prd를 먼저 호출하세요.",
        }

    # Persist handoff row and (if accepted) transition state atomically.
    handoff_id = str(uuid.uuid4())
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    transitioned = False

    with connection() as conn:
        session_row = conn.execute(
            "SELECT current_session_id, state FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if not session_row:
            return {"ok": False, "accepted": False, "error": "project not found"}
        session_id = session_row["current_session_id"]
        current_state = session_row["state"]

        conn.execute(
            """
            INSERT INTO handoffs (
                id, session_id, schema_version, prd_snapshot_path, design_snapshot_path,
                completeness, unresolved_questions, assumptions_made,
                tech_constraints, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                handoff_id,
                session_id,
                "1.0",
                str(prd_path),
                str(design_path) if design_path.exists() else str(prd_path),
                json.dumps(completeness),
                json.dumps(args["unresolved_questions"]),
                json.dumps(args["assumptions_made"]),
                json.dumps(args["tech_constraints"]),
                now,
            ),
        )

        if accepted and current_state == "planning":
            cur = conn.execute(
                "UPDATE projects SET state = 'plan_ready', updated_at = ? "
                "WHERE id = ? AND state = 'planning'",
                (now, project_id),
            )
            transitioned = cur.rowcount > 0

    return {
        "ok": True,
        "accepted": accepted,
        "transitioned_to_plan_ready": transitioned,
        "handoff_id": handoff_id,
        "min_completeness": min_score,
        "is_sufficient": is_sufficient,
        "has_unresolved": has_unresolved,
        "reason": (
            None
            if accepted
            else (
                "unresolved_questions is non-empty" if has_unresolved
                else f"min completeness {min_score:.2f} < {MIN_COMPLETENESS}"
            )
        ),
    }


TOOL = Tool(name="propose_handoff", schema=SCHEMA, fn=fn)
