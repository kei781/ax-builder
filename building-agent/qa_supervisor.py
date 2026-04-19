"""QA supervision — observation-based (ADR 0001).

Verifies:
  1. package.json exists and has "start" script
  2. `npm install` succeeds
  3. `npm start` boots a server; we **observe** which port it binds to
     (no PORT env injection — the app may hardcode anything)
  4. HTTP probe on observed ports → pick the one that responds

If any step fails, collects a structured gap list the Hermes layer can feed
back to the Planning Agent as bounce-back context.

Why observation: LLMs don't reliably honor env conventions. Observing the
actual bound port is more robust and lets Claude Code be free.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from config import settings


@dataclass
class QaResult:
    ok: bool
    gaps: list[str] = field(default_factory=list)
    detail: str = ""
    observed_port: int | None = None


def _listen_ports_for_pid(pid: int) -> list[int]:
    """Return TCP LISTEN ports held by pid or any of its descendants."""
    # lsof ships on macOS; on Linux mini-PC it's present via `apt install lsof`.
    try:
        proc = subprocess.run(
            ["lsof", "-a", "-iTCP", "-sTCP:LISTEN", "-p", str(pid), "-P", "-n", "-Fn"],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    ports: set[int] = set()
    for line in proc.stdout.splitlines():
        # -Fn emits `n<addr>` lines like `n*:3666` or `n127.0.0.1:3666`.
        if not line.startswith("n"):
            continue
        addr = line[1:]
        if ":" not in addr:
            continue
        try:
            ports.add(int(addr.rsplit(":", 1)[1]))
        except ValueError:
            continue
    return sorted(ports)


def _descendant_pids(pid: int) -> list[int]:
    """`npm start` forks a node child — collect it so lsof sees the real binder."""
    try:
        proc = subprocess.run(
            ["pgrep", "-P", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    out: list[int] = []
    for line in proc.stdout.splitlines():
        try:
            out.append(int(line.strip()))
        except ValueError:
            continue
    return out


def _gather_listen_ports(root_pid: int) -> list[int]:
    pids = [root_pid, *_descendant_pids(root_pid)]
    ports: set[int] = set()
    for p in pids:
        for port in _listen_ports_for_pid(p):
            ports.add(port)
    return sorted(ports)


def _http_responds(port: int, timeout_s: float = 1.5) -> bool:
    """Any 2xx/3xx/4xx means the app is serving HTTP. 5xx/connection-reset = not ready."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/", method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return 200 <= resp.status < 500
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 500
    except (urllib.error.URLError, socket.timeout, ConnectionResetError, OSError):
        return False


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
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

    # ---- 1.5. .env.example check (ADR 0004) ----
    # Required so env tier parsing has something to work with.
    env_example = project_path / ".env.example"
    if not env_example.exists():
        gaps.append(".env.example이 생성되지 않았습니다. PRD §9.2 규격으로 반드시 생성되어야 합니다.")
        return QaResult(ok=False, gaps=gaps, detail=".env.example missing")

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

    # ---- 3. npm start (no PORT injection) + observation ----
    # App binds whatever port it wants. We watch the pid.
    env = {**os.environ}
    env.pop("PORT", None)  # deliberately strip inherited PORT

    server = subprocess.Popen(
        ["npm", "start"],
        cwd=str(project_path),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    deadline = time.monotonic() + max(settings.QA_HEALTH_WAIT_S, 30)
    observed: int | None = None
    try:
        while time.monotonic() < deadline:
            # Process crashed before binding?
            if server.poll() is not None:
                out = b""
                try:
                    out, _ = server.communicate(timeout=2)
                except Exception:
                    pass
                snippet = (out or b"").decode("utf-8", errors="replace")[-2000:]
                gaps.append(
                    f"`npm start`가 즉시 종료됐어요 (exit={server.returncode}). 런타임 에러 확인 필요."
                )
                return QaResult(
                    ok=False,
                    gaps=gaps,
                    detail=f"process exited early\n{snippet}",
                )

            ports = _gather_listen_ports(server.pid)
            if ports:
                for p in ports:
                    if _http_responds(p):
                        observed = p
                        break
                if observed is not None:
                    break
            time.sleep(0.4)

        if observed is None:
            # Collect whatever output we have
            try:
                server.terminate()
                out, _ = server.communicate(timeout=3)
            except Exception:
                out = b""
            snippet = (out or b"").decode("utf-8", errors="replace")[-2000:]
            ports = _gather_listen_ports(server.pid) if server.poll() is None else []
            if ports:
                gaps.append(
                    f"서버가 포트 {ports}에 바인드했지만 HTTP 응답이 없습니다. 라우팅/핸들러 확인 필요."
                )
            else:
                gaps.append("서버가 어떤 포트에도 바인드하지 않았습니다. 런타임 크래시 확인 필요.")
            return QaResult(
                ok=False,
                gaps=gaps,
                detail=f"no HTTP-responsive port observed within {settings.QA_HEALTH_WAIT_S}s\n{snippet}",
            )

        return QaResult(
            ok=True,
            gaps=[],
            detail=f"server responding on observed port {observed}",
            observed_port=observed,
        )
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
