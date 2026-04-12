#!/usr/bin/env python3
"""
ax-builder: Hermes Agent Pipeline Bridge
Handles build -> QA -> fix cycle using Hermes Agent + Claude Code CLI

Usage:
    python hermes_pipeline.py '{"project_path": "/projects/abc", "port": 3001}'

Output: JSON on stdout with build results
Progress: JSON lines on stderr for real-time updates
"""
import sys
import json
import os

PIPELINE_PROMPT = """
당신은 빌드 오케스트레이터입니다. 당신의 역할은 Claude Code CLI를 호출하여 작업을 수행하는 것입니다.

## 절대 규칙
- 코드를 직접 작성하지 마세요. 모든 코딩은 반드시 `claude` CLI를 통해 수행합니다.
- 파일을 직접 생성하거나 수정하지 마세요. 반드시 `claude` CLI에게 시키세요.
- 당신은 오케스트레이터입니다. 판단과 지시만 하고, 실행은 `claude`가 합니다.

## 사용할 명령어

### 코드 생성/수정 시:
```bash
cd {project_path} && claude -p "여기에 지시사항" --allowedTools Bash,Read,Write,Edit
```

### QA 검증 시:
```bash
cd {project_path} && claude -p "여기에 QA 지시사항" --allowedTools Bash,Read,Browser
```

## 파이프라인

### STEP 1: 빌드
아래 명령을 터미널에서 실행하세요:
```bash
cd {project_path} && claude -p "prd.md를 읽고 이 디렉토리에 웹앱을 구현하세요.
규칙:
- 데이터 저장이 필요하면 반드시 SQLite 사용 (./data/app.db)
- MySQL, PostgreSQL 등 외부 DB 의존 금지
- 최소한의 파일 구조로 구현
- README.md에 실행 방법 기록
- 외부 API 키는 .env.example에 주석과 함께 정리
- npm start로 실행 가능하게 package.json 구성
- 포트는 3000 고정" --allowedTools Bash,Read,Write,Edit
```

### STEP 2: 서버 시작
빌드 완료 후, 앱을 실행하세요:
```bash
cd {project_path} && npm install && npm start &
```
몇 초 대기 후 서버가 정상 기동했는지 확인:
```bash
curl -s -o /dev/null -w "%{{http_code}}" http://localhost:{port}
```

### STEP 3: QA
서버가 실행되면 Claude Code CLI로 QA를 수행하세요:
```bash
cd {project_path} && claude -p "prd.md를 읽고, http://localhost:{port} 에 접속하여 모든 기능을 검증하세요.
각 기능별로 실제 사용자처럼 테스트하세요.
결과를 아래 JSON 형식으로 보고하세요:
{{
  \\"features_tested\\": [\\"기능1\\", \\"기능2\\"],
  \\"features_passed\\": [\\"기능1\\"],
  \\"features_failed\\": [{{\\\"name\\\": \\\"기능2\\\", \\\"reason\\\": \\\"설명\\\"}}],
  \\"overall_pass\\": false,
  \\"fix_suggestions\\": [\\"수정 제안\\"]
}}" --allowedTools Bash,Read,Browser
```

### STEP 4: 수정 (QA 실패 시)
QA 결과에서 실패 항목이 있으면, Claude Code CLI로 수정하세요:
```bash
cd {project_path} && claude -p "prd.md를 다시 읽고, 아래 QA 실패 항목을 수정하세요:
[여기에 실패 항목과 fix_suggestions를 붙여넣기]" --allowedTools Bash,Read,Write,Edit
```

### STEP 5: QA 재실행
수정 후 STEP 3을 다시 실행하세요.
QA가 통과될 때까지 STEP 3~4를 반복하세요. 최대 3회 반복.

## 최종 보고
모든 작업이 끝나면 결과를 알려주세요.
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
    Run the full build pipeline.
    Hermes orchestrates, Claude Code CLI does all coding.
    """
    try:
        from run_agent import AIAgent
    except ImportError:
        return {
            "success": False,
            "error": "Hermes Agent가 설치되지 않았습니다. curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
        }

    prd_path = os.path.join(project_path, "prd.md")
    if not os.path.exists(prd_path):
        return {
            "success": False,
            "error": f"PRD 파일을 찾을 수 없습니다: {prd_path}",
        }

    # Verify claude CLI is available
    claude_check = os.popen("which claude").read().strip()
    if not claude_check:
        return {
            "success": False,
            "error": "Claude Code CLI가 설치되지 않았습니다. npm install -g @anthropic-ai/claude-code && claude login",
        }

    emit_progress("setup", "Hermes Agent 초기화 중...", 5)

    prompt = PIPELINE_PROMPT.replace("{project_path}", project_path).replace("{port}", str(port))

    try:
        agent = AIAgent(
            model="anthropic/claude-sonnet-4",
            quiet_mode=True,
            ephemeral_system_prompt=prompt,
            skip_memory=True,
            max_iterations=90,
            # terminal만 허용 — Hermes는 claude CLI 호출만 가능
            enabled_toolsets=["terminal"],
        )

        emit_progress("coding", "Claude Code CLI로 빌드 시작...", 10)

        result = agent.chat(
            f"프로젝트 경로: {project_path}\n포트: {port}\n\n"
            f"prd.md를 읽고 빌드 → QA → 수정 파이프라인을 실행하세요.\n"
            f"모든 코딩은 반드시 `claude` CLI로 수행하세요. 직접 코드를 작성하지 마세요."
        )

        emit_progress("deploy", "파이프라인 완료", 100)

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
