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


PHASE_PROMPT_TEMPLATE = """당신은 이 프로젝트의 "{name}" phase를 구현해야 합니다.

## 작업 디렉토리
현재 cwd가 프로젝트 루트입니다. 모든 파일 경로는 cwd 기준 상대 경로로.

## 기술 스택 (절대 고정)
- Node.js + Express (package.json의 "start" 스크립트로 `npm start` 가능해야 함)
- SQLite (`./data/app.db`, CREATE TABLE IF NOT EXISTS 패턴)
- 정적 프론트엔드 (`public/index.html`, `public/app.js`, `public/styles.css`)
- 단일 포트 서비스. 외부 DB/서비스 금지.

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

    return PHASE_PROMPT_TEMPLATE.format(
        name=phase.name,
        description=phase.description,
        deliverables=", ".join(phase.deliverables) or "(명시되지 않음)",
        prd=prd,
        design=design or "(DESIGN.md 없음)",
        phases_summary=phases_summary,
        previous_summary=previous_summary,
    )


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
