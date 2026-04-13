#!/usr/bin/env python3
"""
ax-builder: PRD/DESIGN Generator via Hermes Agent

Hermes가 Claude Code CLI를 오케스트레이션해 PRD.md + DESIGN.md를 생성.
빌드 파이프라인(hermes_pipeline.py)과 동일 패턴을 유지해 일관성/안정성 확보.

Usage:
    python prd_generator.py '{"work_dir": "/tmp/axb-prd-xxx"}'

Input (work_dir에 미리 준비):
    - conversation.md (필수): 기획 대화 이력
    - current_prd.md (선택): 이전 PRD 초안
    - current_design.md (선택): 이전 DESIGN 초안

Output:
    - stdout: JSON {"success": bool, "has_prd": bool, "has_design": bool, "error"?: str}
    - stderr: Hermes 진행 상황 (JSON progress 라인 포함)
    - work_dir에 PRD.md, DESIGN.md 파일 생성
"""
import sys
import json
import os


GENERATOR_PROMPT = """
당신은 시니어 프로덕트 매니저이자 UI/UX 디자이너 팀을 지휘하는 오케스트레이터입니다.
Claude Code CLI(`claude` 명령)를 호출해 PRD.md와 DESIGN.md를 생성합니다.

## 절대 규칙
- **문서를 직접 작성하지 마세요.** 반드시 `claude` CLI에게 시키세요.
- 당신은 오케스트레이터입니다. 지시와 검증만 합니다.
- 현재 디렉토리에는 이미 대화/기존 초안 파일이 준비되어 있습니다.

## 실행 순서

### STEP 1: 입력 파일 확인
```bash
ls -la
cat conversation.md | head -100
[ -f current_prd.md ] && echo "기존 PRD 있음" && cat current_prd.md | head -50
[ -f current_design.md ] && echo "기존 DESIGN 있음" && cat current_design.md | head -50
```

### STEP 2: PRD와 DESIGN 동시 생성 (병렬로 속도↑)
두 Claude CLI 프로세스를 **백그라운드로 동시 실행**:

```bash
# PRD 에이전트 (백그라운드)
claude -p "현재 디렉토리의 conversation.md를 정독하세요. current_prd.md가 있으면 참고해서 개선하세요.

고품질 Product Requirements Document를 PRD.md 파일로 Write 툴을 통해 생성하세요.

## 필수 섹션
1. 서비스 개요 — 목적, 타겟 유저, 핵심 가치 제안
2. 사용자 플로우 — Step 단위, 테이블/리스트 활용해 상세히
3. 기능 요구사항 — FR1, FR2... 번호 매기고 각 기능 명세
4. 비기능 요구사항 — 성능, 브라우저 지원, 보안, 모바일
5. 기술 설계 — 상태 관리, API/이벤트, 서버 구조, DB 스키마

## 스타일 가이드
- 대화에서 언급된 것만 적지 말고 맥락에서 합리적 기본값 추론해 풍부하게
- 아직 논의 안 된 부분은 '[미정]'으로 표시
- 한국어, 비개발자도 이해할 수 있는 용어
- 반드시 Write 툴로 PRD.md 생성 (stdout 출력 금지)
- 완료 후 'PRD_DONE' 한 줄만 출력" \\
  --permission-mode bypassPermissions \\
  --allowedTools "Read Write Edit Bash" \\
  > /tmp/prd_agent.log 2>&1 &
PRD_PID=$!

# DESIGN 에이전트 (백그라운드)
claude -p "현재 디렉토리의 conversation.md를 정독하세요. current_design.md가 있으면 참고해 개선하세요.

AI 에이전트가 바로 UI 구현에 쓸 수 있는 디자인 시스템 문서 DESIGN.md를 Write 툴로 생성하세요.
(https://news.hada.io/topic?id=28246 형식)

## 필수 섹션
1. Brand Identity — 톤앤매너, 분위기
2. Color Palette — primary/secondary/accent/neutral + hex 값
3. Typography — 폰트 패밀리, 크기 스케일, 굵기
4. Spacing & Layout — 그리드, 간격 체계
5. Components — 버튼/입력/카드 등 주요 컴포넌트 스타일 규칙
6. Depth & Elevation — 그림자, 라운딩
7. Responsive Behavior — breakpoint
8. Design Principles — 3~5개 원칙

## 스타일 가이드
- 대화에 디자인 힌트 없으면 서비스 성격에 맞게 제안
- hex 컬러/폰트/간격 등 구체적 수치 포함 (AI가 바로 쓸 수 있게)
- 반드시 Write 툴로 DESIGN.md 생성
- 완료 후 'DESIGN_DONE' 한 줄만 출력" \\
  --permission-mode bypassPermissions \\
  --allowedTools "Read Write Edit Bash" \\
  > /tmp/design_agent.log 2>&1 &
DESIGN_PID=$!

# 둘 다 완료 대기
wait $PRD_PID
PRD_EXIT=$?
wait $DESIGN_PID
DESIGN_EXIT=$?

echo "PRD exit: $PRD_EXIT, DESIGN exit: $DESIGN_EXIT"
echo "--- PRD log tail ---"
tail -20 /tmp/prd_agent.log
echo "--- DESIGN log tail ---"
tail -20 /tmp/design_agent.log
```

### STEP 3: 결과 검증
```bash
ls -la PRD.md DESIGN.md 2>&1
```

파일이 둘 다 존재하면 완료. 한쪽이 실패했으면 해당 에이전트만 재호출.

## 최종 보고
"PRD.md, DESIGN.md 생성 완료" 또는 실패 원인을 한 줄로 보고하세요.
"""


def emit_progress(phase: str, message: str, progress: int = 0):
    data = {
        "type": "progress",
        "phase": phase,
        "current_task": message,
        "progress_percent": progress,
    }
    print(json.dumps(data), file=sys.stderr, flush=True)


def run_generator(work_dir: str) -> dict:
    if not os.path.isdir(work_dir):
        return {"success": False, "error": f"work_dir 없음: {work_dir}"}

    conv_path = os.path.join(work_dir, "conversation.md")
    if not os.path.exists(conv_path):
        return {"success": False, "error": f"conversation.md 없음: {conv_path}"}

    # Claude CLI 사용 가능 확인
    if not os.popen("which claude").read().strip():
        return {
            "success": False,
            "error": "claude CLI 미설치. npm install -g @anthropic-ai/claude-code && claude login",
        }

    try:
        from run_agent import AIAgent
    except ImportError:
        return {
            "success": False,
            "error": "Hermes Agent 미설치. bridge 설치 안내 참고.",
        }

    emit_progress("setup", "Hermes(오케스트레이터) 초기화", 5)

    hermes_model = os.environ.get("HERMES_MODEL", "google/gemini-3-flash-preview")
    agent = AIAgent(
        model=hermes_model,
        quiet_mode=False,  # stderr로 진행 상황 스트리밍
        ephemeral_system_prompt=GENERATOR_PROMPT,
        skip_memory=True,
        max_iterations=40,
        enabled_toolsets=["terminal"],
    )

    # workDir를 현재 작업 디렉토리로 설정
    os.chdir(work_dir)

    emit_progress("coding", "Claude CLI로 PRD/DESIGN 병렬 생성 중", 20)

    try:
        result = agent.chat(
            f"작업 디렉토리: {work_dir}\n"
            f"STEP 1부터 순서대로 자율 진행하세요.\n"
            f"PRD.md와 DESIGN.md 두 파일 모두 claude CLI가 Write 툴로 생성해야 합니다."
        )
    except Exception as e:
        return {"success": False, "error": f"Hermes 실행 실패: {e}"}

    emit_progress("verify", "결과 파일 검증", 90)

    has_prd = os.path.exists(os.path.join(work_dir, "PRD.md"))
    has_design = os.path.exists(os.path.join(work_dir, "DESIGN.md"))

    emit_progress("done", f"완료 (PRD={has_prd}, DESIGN={has_design})", 100)

    return {
        "success": has_prd or has_design,
        "has_prd": has_prd,
        "has_design": has_design,
        "final_response": (str(result)[:500] if result else ""),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No args"}))
        sys.exit(1)

    args = json.loads(sys.argv[1])
    result = run_generator(**args)
    print(json.dumps(result))
