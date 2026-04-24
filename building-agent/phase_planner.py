"""Phase planner — Hermes layer.

Reads PRD.md and DESIGN.md, asks Gemini to produce a phase plan as JSON,
and writes it to `.ax-build/PHASES.md`. The JSON drives phase_runner; the
.md is for humans (and future debugging).

ARCHITECTURE.md §4.1 / Q1=(b): PRD별 동적 생성.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from config import settings
from llm import ask_json


@dataclass
class Phase:
    name: str
    description: str
    deliverables: list[str]


def _system_prompt(mode: str = "build") -> str:
    if mode == "update":
        # ADR 0008 §D6 — 업데이트 모드: 변경 범위만 phase로. 기존 파일 구조 보존.
        return f"""당신은 시니어 풀스택 테크 리드입니다.
이 프로젝트는 **이미 배포된 앱의 수정**입니다. 처음부터 재생성이 아닙니다.
기존 PRD가 diff 방식으로 갱신됐고, 변경된 부분만 Claude Code가 적용할 phase를 설계하세요.

## 출력 형식
JSON 배열만 출력하세요. 마크다운 펜스나 설명 텍스트 없이 순수 JSON만.

각 phase 객체 형식:
[
  {{"name": "snake_case_id", "description": "변경 내용과 영향 파일 명시", "deliverables": ["path/file.js"]}}
]

## 업데이트 Phase 설계 규칙
- **기존 구조 보존이 최우선**. 새 기능 추가라도 기존 파일을 필요 없으면 건드리지 마세요.
- 변경이 없는 영역(예: 기존 인증, 기존 DB 스키마)은 phase로 포함하지 마세요.
- 변경 영역만 phase로. 3개 이하로 끝나는 경우가 많음. 최대 {settings.MAX_PHASES}개.
- phase 이름은 변경 성격을 담아서: `add_notification_feature`, `fix_cart_bug`, `refactor_checkout_flow` 등.
- description에 **영향받는 파일 경로**와 **영향받지 않는 영역**을 모두 적으세요.
- 마지막 phase는 항상 "qa_fix" — regression 수정 + 새 기능 통합 테스트.

## 기술 스택 (고정, 기존 프로젝트와 동일)
- Backend: Node.js + Express
- DB: SQLite (./data/app.db)
- Frontend: 정적 HTML/CSS/JS (public/)
- 단일 포트 서비스

## 주의
- 전체 재설계가 필요해 보이면 description에 "⚠ 전체 영향"이라고 명시. 그래도 가능한 최소로.
- scaffold phase는 넣지 마세요 — 이미 scaffold된 프로젝트입니다.
"""
    # 기본(첫 빌드) 모드
    return f"""당신은 시니어 풀스택 테크 리드입니다.
주어진 PRD와 DESIGN을 읽고, Claude Code가 순차적으로 실행할 개발 phase를 설계하세요.

## 출력 형식
JSON 배열만 출력하세요. 마크다운 펜스나 설명 텍스트 없이 순수 JSON만.

각 phase 객체 형식:
[
  {{"name": "snake_case_id", "description": "한국어 phase 목표", "deliverables": ["path/file.js"]}}
]

## 기술 스택 (고정)
- Backend: Node.js + Express
- DB: SQLite (./data/app.db)
- Frontend: 정적 HTML/CSS/JS (public/)
- 단일 포트 서비스

## Phase 설계 규칙
- 기본 순서: scaffold → (auth?) → backend → frontend → integration → qa_fix
- 프로젝트 특성에 따라 phase 추가: 인증 필요 시 "auth" phase, 파일 업로드 필요 시 "upload" phase 등
- 각 phase는 독립적으로 의미가 있어야 함.
- 너무 잘게 쪼개지 말 것 (전체 3~6개 phase 권장, 최대 {settings.MAX_PHASES}개)
- 마지막 phase는 항상 "qa_fix" — 통합 테스트 및 런타임 에러 수정용
"""


def _prompt(prd: str, design: str, mode: str) -> list[dict]:
    user_intro = (
        "## PRD (업데이트된 버전 — 기존 대비 변경점을 중심으로 읽으세요)\n"
        if mode == "update"
        else "## PRD\n"
    )
    return [
        {
            "role": "system",
            "content": _system_prompt(mode),
        },
        {
            "role": "user",
            "content": (
                f"{user_intro}{prd}\n\n"
                f"## DESIGN\n{design or '(DESIGN.md 없음 — 기본값 사용)'}\n\n"
                "이 프로젝트의 phase 배열을 JSON으로만 출력하세요."
            ),
        },
    ]


def generate_phases(prd: str, design: str, mode: str = "build") -> list[Phase]:
    raw = ask_json(settings.SLOT_PHASE_PLANNER, _prompt(prd, design, mode))
    if not isinstance(raw, list):
        raise ValueError(f"phase_planner: expected list, got {type(raw).__name__}")

    phases: list[Phase] = []
    for item in raw[: settings.MAX_PHASES]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        description = str(item.get("description", "")).strip()
        deliverables = [str(d) for d in (item.get("deliverables") or []) if d]
        if not name or not description:
            continue
        phases.append(Phase(name=name, description=description, deliverables=deliverables))

    if not phases:
        raise ValueError("phase_planner: no valid phases produced by LLM")
    return phases


def write_phases_md(project_path: Path, phases: list[Phase]) -> Path:
    build_dir = project_path / ".ax-build"
    build_dir.mkdir(parents=True, exist_ok=True)
    path = build_dir / "PHASES.md"

    lines = ["# PHASES", "", "Building Agent가 순차 실행할 개발 phase 계획.", ""]
    for i, p in enumerate(phases, 1):
        lines.append(f"## {i}. {p.name}")
        lines.append("")
        lines.append(p.description)
        if p.deliverables:
            lines.append("")
            lines.append("**산출물**:")
            for d in p.deliverables:
                lines.append(f"- `{d}`")
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")

    # Also drop a machine-readable companion so phase_runner doesn't re-parse md.
    (build_dir / "phases.json").write_text(
        json.dumps(
            [{"name": p.name, "description": p.description, "deliverables": p.deliverables} for p in phases],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
