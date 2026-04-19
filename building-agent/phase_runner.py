"""Phase runner — spawns `claude` CLI per phase, isolated session.

Q2=(β) decision: each phase gets a fresh Claude CLI process so
conversation context from a previous phase can't pollute the next one.
Instead, we inject previous phase summaries as text in the prompt.

The subprocess is given:
  - cwd = projects/{id}/            (Claude's tool cwd)
  - --permission-mode acceptEdits   (auto-accept file writes)
  - --print                         (non-interactive, return when done)
  - prompt = composed from PRD/DESIGN/PHASES/current-phase

stdout/stderr are captured for agent_logs. Success = exit 0.
"""
from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from config import settings
from phase_planner import Phase


@dataclass
class PhaseResult:
    ok: bool
    duration_s: float
    exit_code: int
    stdout: str
    stderr: str
    error: str | None = None


# Static section (no format placeholders — contains JS/regex braces freely).
PHASE_STATIC_RULES = """## 작업 디렉토리
현재 cwd가 프로젝트 루트입니다. 모든 파일 경로는 cwd 기준 상대 경로로.

## 기술 스택 (절대 고정)
- Node.js + Express (package.json의 "start" 스크립트로 `npm start` 가능해야 함)
- SQLite (`./data/app.db`, CREATE TABLE IF NOT EXISTS 패턴)
- 정적 프론트엔드 (`public/index.html`, `public/app.js`, `public/styles.css`)
- 단일 포트 서비스. 외부 DB/서비스 금지.
- **포트**: 앱이 원하는 단일 포트 하나에 바인드하면 됨. 시스템이 실제 바인드된 포트를 관찰해서 라우팅함. `PORT` 환경변수 존중은 **필수 아님** — 하드코딩해도 무방.
- **LLM 호출 (필요 시)**: `process.env.AX_AI_BASE_URL` + `process.env.AX_AI_TOKEN`를 사용해 OpenAI-호환 엔드포인트로 호출 (openai SDK의 `baseURL` 옵션). `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` 등 provider 키를 **코드·`.env.example` 어디에도 넣지 말 것**. 검출되면 빌드 반송.
- **`.env.example` 필수**: 모든 빌드는 `.env.example`을 반드시 생성. 각 변수 블록에 `# 주입: system-injected | user-required | user-optional` 메타라인 포함. `AX_AI_BASE_URL`, `AX_AI_TOKEN`은 `system-injected`로 기본 포함.

## ⭐ mock-first 규칙 (ADR 0005, 반드시 지킬 것)

유저는 빌드 완료 직후 **env 값 없이도 앱을 바로 접속**합니다. 값은 나중에 유지보수 화면에서 입력합니다.
즉 **env 의존 모듈은 반드시 `hasEnv ? real : mock` 분기를 구현**해야 합니다. 값이 없을 때도 앱이 정상적으로 기동하고 기능이 "있는 척" 돌아가야 합니다. mock 응답은 결정적이고 설명적이어야 합니다 (⚠ 마커 포함).

예시(LLM 호출):

```js
// services/llm.js
const REAL = !!process.env.AX_AI_TOKEN;
const { OpenAI } = require('openai');

const client = REAL
  ? new OpenAI({
      baseURL: process.env.AX_AI_BASE_URL,
      apiKey: process.env.AX_AI_TOKEN,
    })
  : null;

async function chat(prompt) {
  if (REAL) {
    const res = await client.chat.completions.create({
      model: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    return res.choices[0].message.content;
  }
  // mock: 결정적 더미 응답
  return `⚠ mock 응답입니다. 환경 설정 후 실제 LLM 호출로 전환됩니다.\\n\\n입력: "${prompt.slice(0, 80)}"`;
}

module.exports = { chat };
```

예시(외부 API):

```js
// services/stripe.js
const REAL = !!process.env.STRIPE_SECRET_KEY;

async function createCharge({ amount, currency }) {
  if (REAL) {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    return stripe.charges.create({ amount, currency });
  }
  // mock: 결정적 성공 응답
  return {
    id: `ch_mock_${Date.now()}`,
    status: 'succeeded',
    amount,
    currency,
    mock: true,
    warning: '⚠ mock 결제 — Stripe 키 입력 후 실제 결제로 전환',
  };
}

module.exports = { createCharge };
```

**체크포인트**: env 의존 모듈 파일마다 `process.env.<AX_* 또는 외부 키>` 참조와 `if (REAL)` 또는 `if (!REAL)` 분기문이 **반드시 함께** 있어야 합니다. 하나라도 빠지면 QA가 반송합니다.

## 밸리데이션 메타라인 (ADR 0006, 선택)
`.env.example`의 user-tier 변수에 다음 메타라인을 추가하면 유저 입력 UI에서 자동으로 인라인 검증됩니다. 형식을 확실히 아는 키에만 추가하고, 모르면 생략하세요.

```
# STRIPE_SECRET_KEY
# 설명: Stripe 결제 시크릿 키
# 발급 방법: Stripe 대시보드 → 개발자 → API 키
# 예시: sk_test_abcdef1234567890
# 필수 여부: required
# 주입: user-required
# 패턴: ^sk_(test|live)_[a-zA-Z0-9]{24,}$
# 길이: 32-128
STRIPE_SECRET_KEY=
```
"""

# Dynamic header/footer with format placeholders. Joined with PHASE_STATIC_RULES
# at compose time so JS/regex braces in the rules don't clash with `.format()`.
PHASE_HEADER_TEMPLATE = """당신은 이 프로젝트의 "{name}" phase를 구현해야 합니다.

"""

PHASE_FOOTER_TEMPLATE = """
## PRD.md (이 프로젝트의 SSoT)
```
{prd}
```

## DESIGN.md
```
{design}
```

## 전체 phase 계획
{phases_summary}

## 이전 phase들의 상태
{previous_summary}

## 이번 phase: {name}
{description}

**예상 산출물**: {deliverables}

## 규칙
- PRD/DESIGN을 벗어나는 기능 추가 금지
- 불필요한 주석·과도한 에러 처리·테스트 금지 — 깔끔한 최소 구현
- 이전 phase에서 만든 파일 구조를 존중하고 확장하세요
- 이번 phase만 구현하세요. 다음 phase 일은 하지 마세요.
- 완료되면 간단히 "PHASE {name} 완료: <3줄 요약>"을 출력하세요.
"""


def _compose_prompt(
    phase: Phase,
    phases: list[Phase],
    phase_idx: int,
    prd: str,
    design: str,
    previous_results: list[tuple[Phase, PhaseResult]],
) -> str:
    phases_summary = "\n".join(
        f"{i + 1}. {p.name} — {p.description}" for i, p in enumerate(phases)
    )
    if previous_results:
        prev_lines = []
        for prev_phase, prev_result in previous_results:
            verdict = "✓ success" if prev_result.ok else "✗ failed"
            prev_lines.append(f"- {prev_phase.name}: {verdict}")
        previous_summary = "\n".join(prev_lines)
    else:
        previous_summary = "(첫 phase입니다)"

    # Header/footer use .format() for dynamic substitution; the static rules
    # block is inserted verbatim so JS/regex braces don't trip the formatter.
    header = PHASE_HEADER_TEMPLATE.format(name=phase.name)
    footer = PHASE_FOOTER_TEMPLATE.format(
        name=phase.name,
        description=phase.description,
        deliverables=", ".join(phase.deliverables) or "(명시되지 않음)",
        prd=prd,
        design=design or "(DESIGN.md 없음)",
        phases_summary=phases_summary,
        previous_summary=previous_summary,
    )
    return header + PHASE_STATIC_RULES + footer


def run_phase(
    phase: Phase,
    phases: list[Phase],
    phase_idx: int,
    project_path: Path,
    prd: str,
    design: str,
    previous_results: list[tuple[Phase, PhaseResult]],
) -> PhaseResult:
    prompt = _compose_prompt(phase, phases, phase_idx, prd, design, previous_results)

    # Ensure Claude's Node path is in PATH (NVM installs under ~/.nvm/...).
    nvm_bin = os.path.expanduser("~/.nvm/versions/node")
    extra_paths: list[str] = []
    if os.path.isdir(nvm_bin):
        # Pick the first node version dir — good enough for single-user dev boxes.
        for sub in sorted(os.listdir(nvm_bin), reverse=True):
            candidate = os.path.join(nvm_bin, sub, "bin")
            if os.path.isfile(os.path.join(candidate, "claude")):
                extra_paths.append(candidate)
                break
    extra_paths.append("/usr/local/bin")
    env = {**os.environ, "PATH": ":".join([*extra_paths, os.environ.get("PATH", "")])}

    cmd = [
        settings.CLAUDE_BIN,
        "--print",
        "--permission-mode",
        "acceptEdits",
        "--output-format",
        "text",
        prompt,
    ]

    start = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(project_path),
            env=env,
            capture_output=True,
            text=True,
            timeout=settings.CLAUDE_PHASE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired as e:
        return PhaseResult(
            ok=False,
            duration_s=time.monotonic() - start,
            exit_code=-1,
            stdout=e.stdout or "",
            stderr=e.stderr or "",
            error=f"timeout after {settings.CLAUDE_PHASE_TIMEOUT_S}s",
        )
    except FileNotFoundError:
        return PhaseResult(
            ok=False,
            duration_s=time.monotonic() - start,
            exit_code=-1,
            stdout="",
            stderr="",
            error=f"claude CLI not found at '{settings.CLAUDE_BIN}'",
        )

    ok = proc.returncode == 0
    return PhaseResult(
        ok=ok,
        duration_s=time.monotonic() - start,
        exit_code=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        error=None if ok else f"claude exited with code {proc.returncode}",
    )
