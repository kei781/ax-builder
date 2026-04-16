#!/usr/bin/env python3
"""Building Agent entrypoint — Hermes supervision layer.

Called by NestJS via `spawn(python orchestrator.py {json-args})`. Runs the
full build pipeline top-to-bottom and emits AgentEvents on stderr. Exits
with:
   0 = success (project ready to deploy)
   2 = bounce-back (send back to Planning)
   1 = unrecoverable error
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

import events
from config import settings
from phase_planner import Phase, generate_phases, write_phases_md
from phase_runner import PhaseResult, run_phase
from qa_supervisor import run_qa


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def main(raw_args: str) -> int:
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError as e:
        print(f"[ba-fatal] invalid args JSON: {e}", file=sys.stderr, flush=True)
        return 1

    project_id: str = args["project_id"]
    project_path = Path(args["project_path"])
    session_id: str | None = args.get("session_id")
    build_id: str | None = args.get("build_id")

    def progress(phase: str, detail: str, pct: int) -> None:
        events.emit(
            "progress",
            project_id=project_id,
            session_id=session_id,
            build_id=build_id,
            phase=phase,
            progress_percent=pct,
            payload={"detail": detail},
        )

    events.log(f"Build started for project {project_id}", path=str(project_path))

    try:
        # -------- 1. Load PRD/DESIGN --------
        progress("setup", "PRD/DESIGN 로딩 중", 2)
        prd = _read(project_path / "PRD.md")
        if not prd.strip():
            events.emit(
                "error",
                project_id=project_id,
                session_id=session_id,
                build_id=build_id,
                payload={"message": "PRD.md가 비어있거나 찾을 수 없습니다."},
            )
            return 1
        design = _read(project_path / "DESIGN.md")

        # -------- 2. Generate PHASES.md --------
        progress("planning", "PHASES.md 생성 중", 5)
        phases = generate_phases(prd, design)
        write_phases_md(project_path, phases)
        events.emit(
            "progress",
            project_id=project_id,
            session_id=session_id,
            build_id=build_id,
            phase="phases_generated",
            progress_percent=10,
            payload={
                "detail": f"{len(phases)} phases 생성",
                "phases": [p.name for p in phases],
            },
        )

        # -------- 3. Execute phases --------
        previous: list[tuple[Phase, PhaseResult]] = []
        n = len(phases)

        for idx, phase in enumerate(phases):
            # Linear 10% → 85% across phases
            pct = 10 + int(75 * idx / n)
            events.emit(
                "phase_start",
                project_id=project_id,
                session_id=session_id,
                build_id=build_id,
                phase=phase.name,
                progress_percent=pct,
                payload={"idx": idx, "description": phase.description},
            )

            result = run_phase(
                phase, phases, idx, project_path, prd, design, previous
            )

            events.emit(
                "phase_end",
                project_id=project_id,
                session_id=session_id,
                build_id=build_id,
                phase=phase.name,
                progress_percent=pct,
                payload={
                    "idx": idx,
                    "ok": result.ok,
                    "exit_code": result.exit_code,
                    "duration_s": round(result.duration_s, 1),
                    "stdout_tail": result.stdout[-1500:],
                    "stderr_tail": result.stderr[-1500:],
                    "error": result.error,
                },
            )

            if not result.ok:
                # Per H2 policy: any phase failure = immediate bounce-back,
                # no local retries (Planning agent fixes the gap).
                gaps = [
                    f"Phase '{phase.name}' 실패: {result.error or 'unknown'}"
                ]
                if result.stderr:
                    gaps.append(f"에러 로그 요약: {result.stderr[-300:]}")
                events.emit(
                    "error",
                    project_id=project_id,
                    session_id=session_id,
                    build_id=build_id,
                    phase=phase.name,
                    payload={
                        "kind": "phase_failure",
                        "message": result.error or "phase failed",
                        "gap_list": gaps,
                    },
                )
                return 2  # bounce-back exit code

            previous.append((phase, result))

        # -------- 4. QA --------
        progress("qa", "npm install + health check", 88)
        events.emit(
            "phase_start",
            project_id=project_id,
            session_id=session_id,
            build_id=build_id,
            phase="qa",
            progress_percent=88,
            payload={"description": "npm install + 서버 기동 검증"},
        )
        qa = run_qa(project_path)
        events.emit(
            "phase_end",
            project_id=project_id,
            session_id=session_id,
            build_id=build_id,
            phase="qa",
            progress_percent=95,
            payload={"ok": qa.ok, "detail": qa.detail, "gap_list": qa.gaps},
        )
        if not qa.ok:
            events.emit(
                "error",
                project_id=project_id,
                session_id=session_id,
                build_id=build_id,
                phase="qa",
                payload={
                    "kind": "qa_failure",
                    "message": qa.detail,
                    "gap_list": qa.gaps,
                },
            )
            return 2

        # -------- 5. Success --------
        events.emit(
            "completion",
            project_id=project_id,
            session_id=session_id,
            build_id=build_id,
            progress_percent=100,
            payload={
                "detail": "빌드 완료",
                "phases": [p.name for p in phases],
                "port": settings.QA_TEST_PORT,
            },
        )
        return 0

    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc(limit=5)
        events.emit(
            "error",
            project_id=project_id,
            session_id=session_id,
            build_id=build_id,
            payload={
                "message": f"{type(e).__name__}: {e}",
                "trace_tail": tb[-1500:],
            },
        )
        return 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: orchestrator.py <json-args>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
