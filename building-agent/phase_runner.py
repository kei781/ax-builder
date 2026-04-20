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

import json
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
- **포트 (반드시 PORT env 존중)**: 앱은 `process.env.PORT` 를 **반드시** 우선 사용하고, 없을 때만 기본값(예: 3000)으로 fallback. 하드코딩 금지.

  ```js
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`listening on ${PORT}`));
  ```

  이유: QA·배포 환경은 여러 프로젝트가 같은 호스트에서 병렬로 기동한다. 모두 3000을 하드코딩하면 두 번째부터 **EADDRINUSE**로 즉시 죽는다. PORT env를 존중하면 시스템이 빈 포트를 주입해 격리할 수 있음. 시스템은 여전히 실제 바인드된 포트를 관찰하지만, 그 전에 유입된 PORT env를 따르는 게 "좋은 시민" 규약.
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

## `.env.example` 작성 규칙 (매우 중요 — 유저 UI 영향 있음)

**한 변수당 한 메타블록**. 여러 변수를 하나의 `# 주입: ...` 아래에 묶어서 쓰지 마세요. 파서는 빈 줄 또는 `KEY=` 한 번마다 메타를 초기화합니다.

각 변수 블록의 표준 형태:

```
# VAR_NAME
# 설명: 비개발자가 이해할 수 있는 한 줄 설명
# 발급 방법: 단계별 안내 (user-tier에만, 필요 시)
# 예시: 포맷 예시 (user-tier에만, 필요 시)
# 필수 여부: required | optional
# 주입: system-injected | user-required | user-optional
# 패턴: <regex>   (선택, 인라인 검증)
# 길이: <min-max> (선택)
VAR_NAME=
```

### `AX_AI_BASE_URL` / `AX_AI_TOKEN` 필수 포함

LLM을 호출하는 앱이든 아니든, AI Gateway 계약상 **반드시** 아래 2개를 `.env.example` 최상단에 포함시킵니다. 두 변수 모두 `system-injected` — 유저는 보지도 만지지도 않습니다. (참고: `AX_*` 네임스페이스는 파서가 메타 무관하게 system-injected로 강제하지만, 문서성을 위해 명시적으로 적으세요.)

```
# AX_AI_BASE_URL
# 설명: ax-builder AI Gateway 엔드포인트 (빌드 시 자동 주입)
# 필수 여부: required
# 주입: system-injected
AX_AI_BASE_URL=

# AX_AI_TOKEN
# 설명: AI Gateway 프로젝트 토큰 (빌드 시 자동 발급)
# 필수 여부: required
# 주입: system-injected
AX_AI_TOKEN=
```

### user-tier 예시 (유저가 직접 입력하는 키)

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

# ADMIN_PASSWORD
# 설명: 관리자 페이지 접근 비밀번호
# 필수 여부: required
# 주입: user-required
# 길이: >=4
ADMIN_PASSWORD=
```

**체크리스트** (생성 전 자가 검증)
- 모든 변수에 `# 주입:` 메타라인이 있는가?
- user-required / user-optional 변수엔 `# 설명:` 필수? (유저가 뭔지 알아야 함)
- 민감 키(Stripe·Slack·OAuth 등)엔 `# 패턴:` 있으면 좋음
- provider 키(ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY 등)는 절대 user-tier로 올리지 말 것 (빌드 반송 대상)
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
{update_mode_rules}"""


# ADR 0008 §D6 — 업데이트 모드에서만 추가되는 규칙.
# 기존 파일 구조 보존이 최우선. Claude Code가 "전부 새로 작성"으로 빠지지 않도록.
UPDATE_MODE_RULES_SUFFIX = """
## ⚠️ 업데이트 모드 추가 규칙 (ADR 0008)
- 이 프로젝트는 **이미 배포된 앱의 수정**입니다. 기존 파일 구조를 **그대로 유지**하세요.
- **기존 파일을 먼저 읽고**, 필요한 부분만 편집. 전체 덮어쓰기 금지.
- PRD에 명시되지 않은 리팩터/스타일 변경 금지. "이 기회에 정리" 같은 판단도 금지.
- 기존 DB 스키마(CREATE TABLE 문)를 깨는 변경 금지. 새 컬럼은 IF NOT EXISTS 패턴으로 추가.
- 기존에 있던 파일을 삭제하려면 phase description에 명시적으로 "삭제: <파일경로>" 이유와 함께 있어야 함.
- 기존 엔드포인트 URL·파라미터 계약은 깨지 마세요. 필요하면 새 엔드포인트 추가.
- package.json의 기존 의존성은 유지. 새 의존성만 추가.
- 변경 후 `npm start`가 여전히 성공해야 하고, 기존 주요 엔드포인트들이 여전히 응답해야 함 (regression).
"""


def _compose_prompt(
    phase: Phase,
    phases: list[Phase],
    phase_idx: int,
    prd: str,
    design: str,
    previous_results: list[tuple[Phase, PhaseResult]],
    mode: str = "build",
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
        update_mode_rules=UPDATE_MODE_RULES_SUFFIX if mode == "update" else "",
    )
    return header + PHASE_STATIC_RULES + footer


def _claude_env() -> dict[str, str]:
    """Claude binary 실행용 env.

    NVM 경로를 PATH 앞쪽에 붙여 `claude` binary를 찾을 수 있게 한다.
    `CLAUDE_CODE_OAUTH_TOKEN` 등 상위에서 상속된 stale 토큰은 orchestrator
    측 ecosystem.config.cjs에서 이미 비워져 있으므로 여기서 추가 조치 없음.
    """
    nvm_bin = os.path.expanduser("~/.nvm/versions/node")
    extra_paths: list[str] = []
    if os.path.isdir(nvm_bin):
        for sub in sorted(os.listdir(nvm_bin), reverse=True):
            candidate = os.path.join(nvm_bin, sub, "bin")
            if os.path.isfile(os.path.join(candidate, "claude")):
                extra_paths.append(candidate)
                break
    extra_paths.append("/usr/local/bin")
    return {
        **os.environ,
        "PATH": ":".join([*extra_paths, os.environ.get("PATH", "")]),
    }


def _run_claude_stream(
    prompt: str, cwd: Path, timeout: float
) -> tuple[bool, str, str, int, list[str]]:
    """ADR 0009 — Claude Code를 stream-json 프로토콜로 호출.

    stdin에 `{"type":"user","message":{...}}` JSON line 하나 보내고, stdout에
    쏟아지는 이벤트 스트림을 읽어 최종 `{"type":"result"}` 신호가 올 때까지 대기.

    Claude Code는 내부 tool loop(Read/Write/Edit/Bash/Glob/Grep)를 자율 수행
    하고, 완료 시 `result.is_error` / `result.result` 필드로 결과를 알려준다.
    Hermes는 이벤트만 관찰 — 파일 편집·명령 실행은 전부 Claude가 수행.

    Returns: (ok, final_text, tool_use_log, num_tool_uses, error_lines)
    """
    env = _claude_env()
    cmd = [
        settings.CLAUDE_BIN,
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--permission-mode", "acceptEdits",
        "--verbose",
    ]

    user_msg = json.dumps({
        "type": "user",
        "message": {"role": "user", "content": prompt},
    }, ensure_ascii=False)

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as e:
        raise RuntimeError(
            f"claude CLI not found at '{settings.CLAUDE_BIN}': {e}"
        ) from e

    # 단일 턴 — user message 하나 보내고 stdin EOF.
    try:
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(user_msg + "\n")
        proc.stdin.flush()
        proc.stdin.close()

        # 이벤트 스트림 읽기. 마지막 `type: result` 도착이 종료 신호.
        tool_use_log: list[str] = []
        num_tool_uses = 0
        error_lines: list[str] = []
        final_text = ""
        ok = False
        result_seen = False

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                # EOF — 프로세스 종료 확인
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
                continue
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                error_lines.append(f"[non-JSON stdout] {line[:200]}")
                continue

            t = evt.get("type")
            if t == "assistant":
                # tool_use 이벤트 로그
                msg = evt.get("message", {})
                for item in msg.get("content", []) or []:
                    if isinstance(item, dict) and item.get("type") == "tool_use":
                        tname = item.get("name", "?")
                        targs = item.get("input", {})
                        path = targs.get("file_path") or targs.get("path") or ""
                        num_tool_uses += 1
                        tool_use_log.append(f"  - {tname}({path})"[:120])
            elif t == "result":
                result_seen = True
                ok = not bool(evt.get("is_error"))
                final_text = evt.get("result") or ""
                break
            # system/user(tool_result)/rate_limit_event 등은 무시

        if not result_seen:
            # timeout or abnormal exit
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            return False, final_text or "(no result)", "\n".join(tool_use_log), num_tool_uses, error_lines + [
                f"claude stream-json did not emit 'result' within {timeout}s (exit={proc.returncode})"
            ]

        # stderr tail — 디버깅용
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.terminate()
        stderr_text = ""
        if proc.stderr is not None:
            try:
                stderr_text = proc.stderr.read() or ""
            except Exception:
                stderr_text = ""
        if stderr_text.strip():
            error_lines.extend(stderr_text.strip().splitlines()[-10:])

        return ok, final_text, "\n".join(tool_use_log), num_tool_uses, error_lines
    finally:
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass


def run_phase(
    phase: Phase,
    phases: list[Phase],
    phase_idx: int,
    project_path: Path,
    prd: str,
    design: str,
    previous_results: list[tuple[Phase, PhaseResult]],
    mode: str = "build",
) -> PhaseResult:
    """ADR 0009 — Claude Code를 stream-json으로 호출.

    이전 `claude --print --output-format text` subprocess 방식을 대체.
    stdout 파싱 오염(warning 섞임, stdout vs stderr 구분 실패) 제거 + tool use
    loop는 Claude가 전담해 에이전틱 구조 유지 + OAuth 구독 크레딧 사용.
    """
    prompt = _compose_prompt(
        phase, phases, phase_idx, prd, design, previous_results, mode=mode
    )
    start = time.monotonic()

    try:
        ok, final_text, tool_log, num_tools, errs = _run_claude_stream(
            prompt, project_path, timeout=float(settings.CLAUDE_PHASE_TIMEOUT_S)
        )
    except RuntimeError as e:
        return PhaseResult(
            ok=False,
            duration_s=time.monotonic() - start,
            exit_code=-1,
            stdout="",
            stderr=str(e),
            error=str(e),
        )

    # stdout = 최종 result 텍스트 + tool use 요약 (classifier 입력 풍부화)
    stdout_combined = final_text
    if tool_log:
        stdout_combined += f"\n\n[tool_uses={num_tools}]\n{tool_log}"

    return PhaseResult(
        ok=ok,
        duration_s=time.monotonic() - start,
        exit_code=0 if ok else 1,
        stdout=stdout_combined,
        stderr="\n".join(errs[-20:]) if errs else "",
        error=None if ok else f"claude stream-json reported is_error=true: {final_text[:500]}",
    )
