"""evaluate_readiness — lightweight completeness check without state transition.

Unlike `propose_handoff` (which transitions planning → plan_ready), this tool
just evaluates the current PRD/DESIGN maturity and returns scores. The
frontend uses these scores to show a real-time progress sidebar.

The agent should call this:
  - After every write_prd / write_design call
  - Every 3-4 turns of conversation
  - When the user asks about progress
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.agent.tools.base import Tool, ToolCtx, ToolSchema
from app.config import settings

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
        "name": "evaluate_readiness",
        "description": (
            "현재 PRD/DESIGN의 완성도를 자체 평가합니다. "
            "5개 항목(문제 정의, 기능 목록, 사용자 플로우, 실현 가능성, 사용자 경험)을 "
            "각각 0.0~1.0으로 평가하세요. "
            "이 도구는 상태 전이를 하지 않습니다 — 순수하게 현재 상태의 스냅샷입니다. "
            "write_prd 호출 직후, 또는 3~4턴의 대화마다 호출하여 "
            "사용자에게 진행 상황을 보여주세요."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "completeness": {
                    "type": "object",
                    "description": "각 항목을 0.0~1.0 사이 실수로 자체 평가",
                    "properties": {
                        "problem_definition": {
                            "type": "number",
                            "description": "해결하려는 문제가 구체적인가?",
                        },
                        "feature_list": {
                            "type": "number",
                            "description": "핵심 기능이 명시됐는가?",
                        },
                        "user_flow": {
                            "type": "number",
                            "description": "사용자가 어떤 순서로 기능을 쓰는지 명확한가?",
                        },
                        "feasibility": {
                            "type": "number",
                            "description": "단일 웹앱으로 구현 가능한 범위인가?",
                        },
                        "user_experience": {
                            "type": "number",
                            "description": "화면·상호작용이 어느 정도 그려지는가?",
                        },
                    },
                    "required": list(COMPLETENESS_KEYS),
                },
                "summary": {
                    "type": "string",
                    "description": "현재 상태를 한 줄로 요약 (예: '기능은 정리됐지만 유저 플로우가 아직 모호합니다')",
                },
            },
            "required": ["completeness", "summary"],
        },
    },
}


async def fn(ctx: ToolCtx, args: dict[str, Any]) -> dict[str, Any]:
    comp = args.get("completeness") or {}
    summary = args.get("summary", "")

    # Validate
    scores: dict[str, float] = {}
    for key in COMPLETENESS_KEYS:
        val = comp.get(key)
        if not isinstance(val, (int, float)):
            return {"ok": False, "error": f"completeness.{key} must be a number"}
        scores[key] = max(0.0, min(1.0, float(val)))

    total = sum(scores.values())
    avg = total / len(scores) if scores else 0
    # Map to 0-1000 range like the old scoring system for UI continuity
    score_1000 = int(avg * 1000)
    min_score = min(scores.values())
    can_build = min_score >= 0.6

    return {
        "ok": True,
        "completeness": scores,
        "score": score_1000,
        "min_completeness": round(min_score, 2),
        "can_build": can_build,
        "summary": summary,
        "label": (
            "빌드 가능" if can_build
            else "보완 필요" if avg >= 0.4
            else "기획 초기 단계"
        ),
    }


TOOL = Tool(name="evaluate_readiness", schema=SCHEMA, fn=fn)
