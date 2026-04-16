"""QA supervision — MVP version (Step 5).

Verifies:
  1. package.json exists and has "start" script
  2. `npm install` succeeds
  3. `npm start` boots a server and responds on QA_TEST_PORT within a few seconds

If any step fails, collects a structured gap list the Hermes layer can feed
back to the Planning Agent as bounce-back context.

Full functional QA (curl-based per-endpoint testing) is Step 7 — for now
we only verify "the app at least boots without crashing".
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from config import settings


@dataclass
class QaResult:
    ok: bool
    gaps: list[str] = field(default_factory=list)
    detail: str = ""


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _wait_for_port(port: int, timeout_s: int) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _port_in_use(port):
            return True
        time.sleep(0.3)
    return False


def run_qa(project_path: Path) -> QaResult:
    gaps: list[str] = []

    # ---- 1. package.json check ----
    pkg_path = project_path / "package.json"
    if not pkg_path.exists():
        gaps.append("package.json이 생성되지 않았습니다. Scaffold phase가 실패했을 가능성이 높습니다.")
        return QaResult(ok=False, gaps=gaps, detail="package.json missing")
    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        gaps.append(f"package.json이 유효한 JSON이 아닙니다: {e}")
        return QaResult(ok=False, gaps=gaps, detail="package.json invalid")
    if "start" not in (pkg.get("scripts") or {}):
        gaps.append("package.json의 scripts.start가 없습니다. `npm start`로 기동 가능해야 합니다.")
        return QaResult(ok=False, gaps=gaps, detail="scripts.start missing")

    # ---- 2. npm install ----
    install = subprocess.run(
        ["npm", "install", "--silent", "--no-audit", "--no-fund"],
        cwd=str(project_path),
        capture_output=True,
        text=True,
        timeout=settings.NPM_INSTALL_TIMEOUT_S,
    )
    if install.returncode != 0:
        gaps.append("`npm install`이 실패했습니다. package.json의 의존성을 확인하세요.")
        return QaResult(
            ok=False,
            gaps=gaps,
            detail=f"npm install exit={install.returncode}\n{install.stderr[-1000:]}",
        )

    # ---- 3. npm start in background + health check ----
    port = settings.QA_TEST_PORT
    if _port_in_use(port):
        gaps.append(
            f"QA 테스트 포트 {port}가 이미 사용 중입니다. 이전 빌드 프로세스를 확인하세요."
        )
        return QaResult(ok=False, gaps=gaps, detail=f"port {port} in use")

    env = {**os.environ, "PORT": str(port)}
    server = subprocess.Popen(
        ["npm", "start"],
        cwd=str(project_path),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # detachable so SIGTERM hits the whole group
    )
    try:
        if not _wait_for_port(port, settings.QA_HEALTH_WAIT_S):
            # Server didn't start — gather stdout snippet
            try:
                server.terminate()
                out, _ = server.communicate(timeout=3)
            except Exception:
                out = b""
            snippet = (out or b"").decode("utf-8", errors="replace")[-1500:]
            gaps.append(
                f"서버가 포트 {port}에 바인드되지 않았습니다. 런타임 에러 확인 필요."
            )
            return QaResult(
                ok=False,
                gaps=gaps,
                detail=f"server never bound within {settings.QA_HEALTH_WAIT_S}s\n{snippet}",
            )
        # Health OK — tear down cleanly
        return QaResult(ok=True, gaps=[], detail=f"server responding on port {port}")
    finally:
        if server.poll() is None:
            try:
                os.killpg(os.getpgid(server.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(server.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
