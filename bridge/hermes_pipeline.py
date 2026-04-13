#!/usr/bin/env python3
"""
ax-builder: Multi-Agent Build Pipeline

Hermes가 팀 리드(tech lead)로서 Claude Code CLI 서브에이전트들을
병렬/순차로 조합해 PRD.md + DESIGN.md → 실제 웹앱으로 자율 개발.

Team Structure:
- Scaffold Agent: 프로젝트 골격, package.json, 의존성
- Backend Agent: API, DB, 비즈니스 로직 (SQLite)
- Frontend Agent: UI, DESIGN.md 준수한 시각 구현
- Integration Agent: 프론트↔백엔드 연결, E2E 동작
- QA Agent: 브라우저 테스트, 시각적 검증, 수정 지시

Usage:
    python hermes_pipeline.py '{"project_path": "/projects/abc", "port": 3001}'
"""
import sys
import json
import os

PIPELINE_PROMPT = """
당신은 **시니어 Tech Lead**입니다. PRD.md와 DESIGN.md를 바탕으로
Claude Code CLI 서브에이전트 팀을 구성해 웹앱을 자율적으로 개발합니다.

## 절대 규칙
- 코드를 직접 작성하지 마세요. 모든 코딩은 반드시 `claude` CLI 서브에이전트가 합니다.
- 당신은 오케스트레이터/팀 리드입니다. 작업 분할과 지시, 통합 검증만 담당합니다.
- 병렬로 돌릴 수 있는 작업은 `&`로 병렬 실행해 속도를 최대화하세요.
- 각 서브에이전트 호출은 **narrow한 단일 책임**으로 제한 (코드 품질↑, 컨텍스트↓).

## 팀 구성 (서브에이전트 역할)

| 에이전트 | 책임 | 허용 툴 |
|---|---|---|
| Scaffold | 디렉토리 구조, package.json, 의존성 설치, 서버 엔트리 | Bash,Read,Write,Edit |
| Backend | API 라우트, SQLite 스키마, 데이터 로직 | Bash,Read,Write,Edit |
| Frontend | HTML/CSS/JS, DESIGN.md 준수, 정적 asset | Bash,Read,Write,Edit |
| Integration | API↔UI 연결, 누락 와이어링, 전체 스모크 | Bash,Read,Write,Edit |
| QA | curl/브라우저로 실제 동작 검증, 버그 리포트 | Bash,Read |
| Fixer | QA가 낸 버그 수정 | Bash,Read,Write,Edit |

## 빌드 파이프라인 (자율 진행)

### PHASE 1: 설계 파악 (당신이 직접)
터미널에서 다음 실행:
```bash
cat {project_path}/PRD.md
cat {project_path}/DESIGN.md 2>/dev/null || echo "(DESIGN.md 없음)"
ls {project_path}/
```
PRD/DESIGN을 스스로 읽고, 어떤 기능 모듈로 쪼갤지 설계. 최소 파일 수로 구현 가능한 구조를 선택.

### PHASE 2: Scaffold (단일 에이전트, 빠르게)
```bash
cd {project_path} && claude -p "PRD.md와 DESIGN.md를 읽고 프로젝트 스캐폴드를 만드세요.
규칙:
- 단일 Node.js/Express 앱 (포트 {port})
- SQLite(./data/app.db) 사용, 외부 DB 금지
- package.json의 start 스크립트로 실행 가능
- public/ 디렉토리에 정적 파일, src/server.js에 서버
- DESIGN.md가 있으면 CSS 변수(--color-primary 등)로 컬러/폰트 정의한 public/styles.css 생성
- 필요한 npm 패키지까지 설치 완료
완료 후 'SCAFFOLD_DONE'을 출력하세요." --allowedTools Bash,Read,Write,Edit
```

### PHASE 3: Backend + Frontend 병렬 개발
두 에이전트를 **동시 실행**해 개발 속도를 2배로:
```bash
# Backend 에이전트 (백그라운드)
cd {project_path} && claude -p "PRD.md를 읽고 백엔드 API를 구현하세요.
- src/server.js에 모든 라우트 구현 (또는 src/routes/ 로 분리)
- SQLite 스키마는 기동 시 자동 생성 (CREATE TABLE IF NOT EXISTS)
- PRD의 모든 기능 요구사항(FR1, FR2...)을 API로 노출
- 에러 핸들링 포함 (400/404/500 응답)
- CORS 허용 (같은 호스트 내라 간단히)
프론트엔드 쪽은 건드리지 말고 API만 완성하세요.
완료 후 'BACKEND_DONE'을 출력하세요." --allowedTools Bash,Read,Write,Edit > /tmp/backend_{port}.log 2>&1 &
BACKEND_PID=$!

# Frontend 에이전트 (백그라운드)
cd {project_path} && claude -p "PRD.md와 DESIGN.md를 읽고 프론트엔드 UI를 구현하세요.
- public/index.html을 메인 엔트리로
- DESIGN.md의 컬러, 타이포, 컴포넌트 규칙을 **엄격히** 준수 (컬러 hex 그대로, 폰트 패밀리/크기 준수)
- PRD의 모든 화면/페이지를 구현 (SPA 또는 multi-page)
- API 호출은 fetch()로 /api/* 엔드포인트 사용 (Backend 에이전트와 계약)
- 반응형 레이아웃 (모바일 대응)
- 시각적으로 완성도 높게 — 디자인 목업 수준
백엔드 코드(src/)는 건드리지 말고 public/만 작업하세요.
완료 후 'FRONTEND_DONE'을 출력하세요." --allowedTools Bash,Read,Write,Edit > /tmp/frontend_{port}.log 2>&1 &
FRONTEND_PID=$!

# 둘 다 완료 대기
wait $BACKEND_PID
wait $FRONTEND_PID

# 결과 확인
cat /tmp/backend_{port}.log | tail -20
cat /tmp/frontend_{port}.log | tail -20
```

### PHASE 4: Integration (와이어링 검증)
```bash
cd {project_path} && claude -p "방금 Backend/Frontend가 병렬로 작업을 마쳤습니다.
다음을 수행하세요:
1. 서버 실행: npm install && npm start & (백그라운드)
2. 5초 대기 후 curl http://localhost:{port} 로 응답 확인
3. PRD의 각 기능별 API 엔드포인트를 curl로 테스트
4. 프론트엔드 API 호출 코드와 백엔드 라우트가 일치하는지 검증
5. 불일치(404, 누락된 필드 등)가 있으면 즉시 수정
완료 후 'INTEGRATION_DONE' 또는 'INTEGRATION_FAILED: <이유>'를 출력하세요." --allowedTools Bash,Read,Write,Edit
```

### PHASE 5: QA (시각 + 기능)
```bash
cd {project_path} && claude -p "http://localhost:{port} 에 접속해 QA를 수행하세요.
- curl로 HTML 받아 주요 요소 존재 확인 (title, 핵심 버튼/폼)
- 각 API 엔드포인트 정상 동작 검증
- DESIGN.md 준수 확인 (CSS에서 hex 컬러 값 grep)
- PRD의 모든 기능 요구사항이 실제로 작동하는지 테스트
결과를 아래 JSON으로 stdout에 출력:
{{
  \\"overall_pass\\": true/false,
  \\"features_passed\\": [...],
  \\"features_failed\\": [{{\\\"name\\\": \\\"...\\\", \\\"reason\\\": \\\"...\\\", \\\"fix\\\": \\\"...\\\"}}]
}}" --allowedTools Bash,Read
```

### PHASE 6: Fix (QA 실패 시)
QA가 failed를 냈으면, Fixer 에이전트 호출:
```bash
cd {project_path} && claude -p "QA에서 다음 이슈가 발견됐습니다:
[여기에 features_failed JSON 붙여넣기]
각 이슈를 수정하세요. PRD.md와 DESIGN.md 규칙 준수.
완료 후 'FIX_DONE'을 출력하세요." --allowedTools Bash,Read,Write,Edit
```
그 후 PHASE 5를 다시 실행. **최대 3회 반복**. 3회 후에도 실패면 중단하고 현재 상태로 종료.

## 최종 보고
모든 단계가 끝나면 한 줄로 보고: "빌드 완료. http://localhost:{port} 에서 확인 가능."

## 효율 규칙
- 중복 질문/중복 파일 읽기 금지
- 한 서브에이전트 호출 안에서 여러 작업을 묶어서 지시 (호출 오버헤드 감소)
- 병렬 가능한 작업은 반드시 병렬 (&)
- 실패 시 재시도는 최대 3회
"""


def emit_progress(phase: str, message: str, progress: int = 0):
    """Emit progress to stderr for NestJS to capture via WebSocket."""
    data = {
        "type": "progress",
        "phase": phase,
        "current_task": message,
        "progress_percent": progress,
    }
    print(json.dumps(data), file=sys.stderr, flush=True)


def run_pipeline(project_path: str, port: int) -> dict:
    """
    Run the multi-agent build pipeline.
    Hermes (tech lead) orchestrates multiple Claude Code CLI subagents in parallel.
    """
    try:
        from run_agent import AIAgent
    except ImportError:
        return {
            "success": False,
            "error": "Hermes Agent가 설치되지 않았습니다. curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
        }

    prd_path = os.path.join(project_path, "PRD.md")
    if not os.path.exists(prd_path):
        # 호환: 소문자 prd.md도 허용
        legacy = os.path.join(project_path, "prd.md")
        if os.path.exists(legacy):
            prd_path = legacy
        else:
            return {
                "success": False,
                "error": f"PRD 파일을 찾을 수 없습니다: {prd_path}",
            }

    design_path = os.path.join(project_path, "DESIGN.md")
    has_design = os.path.exists(design_path)

    # Verify claude CLI is available
    claude_check = os.popen("which claude").read().strip()
    if not claude_check:
        return {
            "success": False,
            "error": "Claude Code CLI가 설치되지 않았습니다. npm install -g @anthropic-ai/claude-code && claude login",
        }

    emit_progress("setup", f"에이전트팀 구성 중... (DESIGN.md {'있음' if has_design else '없음'})", 5)

    prompt = PIPELINE_PROMPT.replace("{project_path}", project_path).replace("{port}", str(port))

    try:
        # Tech Lead 모델: Gemini 3 Flash (빠르고 저렴) — 실제 코딩은 Claude CLI 서브에이전트가
        hermes_model = os.environ.get("HERMES_MODEL", "google/gemini-3-flash-preview")
        agent = AIAgent(
            model=hermes_model,
            quiet_mode=False,  # 진행 상황을 stderr로 스트리밍
            ephemeral_system_prompt=prompt,
            skip_memory=True,
            max_iterations=120,  # 다중 에이전트라 좀 더 여유
            enabled_toolsets=["terminal"],
        )

        emit_progress("coding", "에이전트팀 자율 개발 시작 (Scaffold → Backend+Frontend 병렬 → Integration → QA)", 10)

        result = agent.chat(
            f"프로젝트: {project_path}\n포트: {port}\n"
            f"PRD.md: ✅\nDESIGN.md: {'✅' if has_design else '❌ (없으면 기본 스타일로 진행)'}\n\n"
            f"PHASE 1부터 순서대로 자율 진행하세요. Backend/Frontend는 반드시 병렬(&)로 실행.\n"
            f"모든 코딩은 `claude` CLI 서브에이전트가 합니다. 직접 코드 작성 금지."
        )

        emit_progress("deploy", "에이전트팀 개발 완료", 100)

        return {
            "success": True,
            "final_response": result if isinstance(result, str) else str(result),
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No arguments provided"}))
        sys.exit(1)

    args = json.loads(sys.argv[1])
    result = run_pipeline(**args)
    print(json.dumps(result))
