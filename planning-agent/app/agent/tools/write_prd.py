"""write_prd — persist the project's PRD.md to disk.

Per ARCHITECTURE §6.2 the markdown file is the SSoT. The tool writes
the content; validation/completeness evaluation is a separate concern.

2026-04-24 §8 후속 (베키 "랜덤 간식 당번 → Todo App" PRD 전면 교체 사고 대응):
UPDATE 모드에서 세 겹 방어가 추가됐다.

1. **자동 백업**: 기존 PRD가 있으면 write 직전 `PRD.md.bak.{iso8601}`로 스냅샷.
   첫 빌드/업데이트 무관하게 적용. 이 스냅샷은 "PRD 버전 복원" 기능의 기반.
2. **변경률 가드 (UPDATE 모드 한정)**: 기존 PRD 대비 difflib.SequenceMatcher
   ratio가 0.5 미만이면 도구가 거부하고 AI에게 가이드 반환. 첫 빌드는 적용
   안 함 (처음 작성이라 기존 내용이 없음).
3. **tools/base.ToolCtx 사용**: 세션/업데이트 라인 여부를 핸들러가 알 수 있다.
"""
from __future__ import annotations

import datetime as _dt
import difflib
import logging
from pathlib import Path

from app.agent.tools.base import Tool, ToolCtx, ToolSchema
from app.config import settings

log = logging.getLogger(__name__)


SCHEMA: ToolSchema = {
    "type": "function",
    "function": {
        "name": "write_prd",
        "description": (
            "프로젝트의 PRD.md 파일을 생성하거나 전체를 덮어씁니다. "
            "내용은 완전한 마크다운 문서여야 하며, 기능 요구사항·사용자 플로우·"
            "비즈니스 로직 등 사용자가 결정해야 하는 영역을 포함해야 합니다. "
            "데이터 모델·포트·인증방식 같은 기술 결정은 당신이 자체적으로 채워주세요. "
            "대화가 충분히 구체화됐을 때 사용하세요. 매 턴마다 호출할 필요는 없습니다. "
            "업데이트 라인(planning_update)에서는 기존 PRD의 변경되지 않는 섹션을 "
            "원문 그대로 복제해야 합니다 — 변경률이 50%를 넘으면 시스템이 자동 거부합니다."
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


# UPDATE 모드 write_prd 거부 시그널 — 두 개를 OR로 묶는다.
#
# (A) `_UPDATE_MIN_SIMILARITY`: difflib ratio 미만이면 "전면 재작성"으로 간주.
#     7526a154 사건 실측: 간식 당번 → Todo App 교체 시 0.106. 정상 대규모 리팩토링
#     (같은 도메인 내 섹션 재구성 + 신규 기능 3~5개 추가) 실측 0.311~0.835. 경계
#     0.3으로 잡으면 사건은 잡히고 정상 리팩토링은 통과.
#
# (B) `_H1_CHANGE_MAX_SIMILARITY`: H1(최상단 마크다운 제목)이 바뀌면 유사도가
#     0.7 미만일 때 reject. 같은 도메인 내 리팩토링은 H1이 보통 유지되므로
#     "H1이 바뀐다" = "도메인이 바뀐다"로 해석해도 대부분 맞다. 0.7은 H1만 바꾸는
#     오타 수정 같은 유스케이스는 허용(sim이 1.0 근처라).
_UPDATE_MIN_SIMILARITY = 0.3
_H1_CHANGE_MAX_SIMILARITY = 0.7


def _extract_h1(markdown: str) -> str:
    """첫 번째 `# ...` 줄을 반환. 없으면 빈 문자열."""
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            return stripped[2:].strip()
    return ""


def _now_iso() -> str:
    """`2026-04-24T13:05:22Z` 형태. 백업 파일명 및 로그용."""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _backup_path(prd_path: Path, stamp: str) -> Path:
    return prd_path.with_suffix(f".md.bak.{stamp}")


async def fn(ctx: ToolCtx, args: dict) -> dict:
    content: str = args.get("content", "") or ""
    if not content.strip():
        return {"ok": False, "error": "content is empty"}

    project_dir = Path(settings.PROJECTS_BASE_DIR) / ctx.project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    prd_path = project_dir / "PRD.md"

    existing: str | None = None
    try:
        existing = prd_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        existing = None
    except OSError:
        log.exception("failed to read existing PRD for %s", ctx.project_id)
        existing = None

    # --- UPDATE 모드 변경률 가드 ---
    # 첫 빌드(existing이 None이거나 빈 파일)는 가드 적용 안 함. 처음 쓰는 거라
    # 기준이 없음. UPDATE 모드에서 기존 파일이 있으면 similarity + H1 체크.
    if ctx.is_update_mode and existing and existing.strip():
        similarity = difflib.SequenceMatcher(
            a=existing, b=content, autojunk=False
        ).ratio()

        old_h1 = _extract_h1(existing)
        new_h1 = _extract_h1(content)
        h1_changed = bool(old_h1 and new_h1 and old_h1 != new_h1)

        reject_reason: str | None = None
        if similarity < _UPDATE_MIN_SIMILARITY:
            reject_reason = (
                f"기존 PRD와의 유사도가 {similarity:.1%}로 "
                f"임계치({_UPDATE_MIN_SIMILARITY:.0%}) 미만입니다 — 사실상 전체 재작성"
            )
        elif h1_changed and similarity < _H1_CHANGE_MAX_SIMILARITY:
            reject_reason = (
                f"최상단 제목이 '{old_h1}' → '{new_h1}'로 변경됐고 "
                f"유사도도 {similarity:.1%}에 그칩니다 — 도메인 전환으로 보입니다"
            )

        if reject_reason:
            log.warning(
                "write_prd rejected (project=%s session=%s existing=%dB new=%dB "
                "sim=%.3f h1_changed=%s): %s",
                ctx.project_id,
                ctx.session_id,
                len(existing.encode("utf-8")),
                len(content.encode("utf-8")),
                similarity,
                h1_changed,
                reject_reason,
            )
            return {
                "ok": False,
                "error": "update_overwrite_rejected",
                "similarity": round(similarity, 3),
                "threshold": _UPDATE_MIN_SIMILARITY,
                "existing_h1": old_h1,
                "new_h1": new_h1,
                "message": (
                    f"업데이트 라인 write_prd 거부: {reject_reason}. "
                    "이대로 저장하면 기존 기획이 대부분 사라집니다. "
                    "다음 중 하나로 재시도하세요:\n"
                    "1) `<EXISTING_PRD>`의 변경 없는 섹션은 원문 그대로 복제하고 "
                    "변경/추가 부분만 수정한 content를 다시 제출,\n"
                    "2) 도메인 자체가 바뀌어야 한다면 유저에게 "
                    "'이건 새 프로젝트로 만드는 게 낫지 않을까요?'라고 먼저 질문."
                ),
            }

    # --- 자동 백업 ---
    # 기존 파일이 있으면 항상 백업. 실패해도 원본 write는 진행(백업 실패는
    # 복구 가능성 감소일 뿐, 진행을 막을 이유는 아님). 기록만.
    backup_info: dict | None = None
    if existing is not None:
        stamp = _now_iso()
        bak = _backup_path(prd_path, stamp)
        try:
            bak.write_text(existing, encoding="utf-8")
            backup_info = {"path": str(bak), "bytes": len(existing.encode("utf-8"))}
        except OSError:
            log.exception(
                "failed to backup PRD before overwrite (project=%s)",
                ctx.project_id,
            )

    prd_path.write_text(content, encoding="utf-8")

    result: dict = {
        "ok": True,
        "path": str(prd_path),
        "bytes": len(content.encode("utf-8")),
    }
    if backup_info is not None:
        result["backup"] = backup_info
    return result


TOOL = Tool(name="write_prd", schema=SCHEMA, fn=fn)
