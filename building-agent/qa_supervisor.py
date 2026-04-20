"""QA supervision — observation-based (ADR 0001 + 0008).

Verifies:
  1. package.json exists and has "start" script
  2. `npm install` succeeds
  3. `npm start` boots a server; we **observe** which port it binds to
     (no PORT env injection — the app may hardcode anything)
  4. HTTP probe on observed ports → pick the one that responds
  5. (ADR 0008) update 모드면 이전 버전의 primary_endpoints가 여전히 응답하는지
     확인 — regression 가드

If any step fails, collects a structured gap list the Hermes layer can feed
back to the Planning Agent as bounce-back context.

Why observation: LLMs don't reliably honor env conventions. Observing the
actual bound port is more robust and lets Claude Code be free.
"""
from __future__ import annotations

import json
import os
import re
import signal
import socket
import sqlite3
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
    # ADR 0008 — 빌드가 성공적으로 응답한 primary endpoint 리스트.
    # orchestrator가 project_versions에 저장해 이후 업데이트 QA의 regression 기준으로 사용.
    primary_endpoints: list[str] = field(default_factory=list)


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


def _find_free_port() -> int:
    """OS가 골라주는 임의의 비어있는 TCP 포트.

    QA 프로세스에 PORT env로 주입해 앱이 이 포트에 바인드하도록 유도.
    다른 플랫폼 프로세스(orchestrator 4000, planning 4100 등)와 충돌 방지를
    위해 OS 위임 사용 (사용 가능성이 가장 확실).
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# 앱이 PORT env를 무시하고 하드코딩하는 흔한 포트 — QA가 "왜 실패했는지"
# 유저에게 설명하기 위해 감지.
_HARDCODED_COMMON_PORTS = [3000, 5000, 8000, 8080, 3001]


# Express/Koa/Fastify 스타일 라우트 추출 — 가장 흔한 패턴만 잡는다.
# 경로에 :param·쿼리 없는 literal만 대상. 동적 경로는 표본화 못하므로 패스.
_ROUTE_RE = re.compile(
    r"""\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"]([^'"\s]+)['"]""",
    re.IGNORECASE,
)
# source-level 라우트 스캔 대상 확장자.
_SCAN_EXTENSIONS = (".js", ".mjs", ".cjs", ".ts")
# 스캔할 전형적 디렉토리. 프론트 번들(public/)는 제외 — 서버 라우트만.
_SCAN_DIRS = ("", "src", "routes", "src/routes", "api", "src/api")


def _scan_routes(project_path: Path) -> list[str]:
    """Scan source files for Express-style GET routes.

    `/` 는 항상 포함. 동적 파라미터(:id) 포함한 경로는 제외 (probe 불가).
    찾은 경로를 중복 제거해 정렬된 리스트로 반환.
    """
    found: set[str] = {"/"}
    for rel in _SCAN_DIRS:
        root = project_path / rel if rel else project_path
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix not in _SCAN_EXTENSIONS:
                continue
            # public/ 아래 정적 JS는 프론트엔드이므로 제외
            rel_parts = path.relative_to(project_path).parts
            if rel_parts and rel_parts[0] in ("public", "node_modules", ".ax-build"):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for match in _ROUTE_RE.findall(text):
                route = match.strip()
                # 동적 파라미터·와일드카드 제거
                if ":" in route or "*" in route:
                    continue
                if not route.startswith("/"):
                    continue
                found.add(route)
    return sorted(found)


def _probe_primary_endpoints(
    port: int, routes: list[str]
) -> tuple[list[str], list[str]]:
    """Return (responsive, failed) endpoint lists.

    2xx/3xx/4xx = "app is serving" (regression 아님).
    5xx/connection error = 실제 regression 후보.
    """
    responsive: list[str] = []
    failed: list[str] = []
    for route in routes:
        if _http_responds(port, timeout_s=2.0) is False and route == "/":
            # 루트가 이미 죽었으면 더 볼 필요 없음
            failed.append(route)
            continue
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}{route}", method="HEAD"
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if 200 <= resp.status < 500:
                    responsive.append(route)
                else:
                    failed.append(route)
        except urllib.error.HTTPError as e:
            # 4xx도 "응답하고 있음"으로 간주. 5xx만 regression.
            if 200 <= e.code < 500:
                responsive.append(route)
            else:
                failed.append(route)
        except (
            urllib.error.URLError,
            socket.timeout,
            ConnectionResetError,
            OSError,
        ):
            failed.append(route)
    return responsive, failed


def _load_previous_primary_endpoints(project_id: str) -> list[str]:
    """Fetch the most recent project_versions row's primary_endpoints (JSON)."""
    db_path = Path(settings.DB_PATH)
    if not db_path.exists():
        return []
    try:
        conn = sqlite3.connect(str(db_path), isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT primary_endpoints FROM project_versions "
                "WHERE project_id = ? ORDER BY deployed_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return []
    if not row or not row["primary_endpoints"]:
        return []
    try:
        parsed = json.loads(row["primary_endpoints"])
    except (json.JSONDecodeError, TypeError):
        return []
    return [r for r in parsed if isinstance(r, str) and r.startswith("/")]


def run_qa(
    project_path: Path,
    project_id: str | None = None,
    mode: str = "build",
) -> QaResult:
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

    # ---- 3. npm start + PORT 격리 + observation ----
    # 이전 방식: PORT env 무시, 앱 하드코딩 포트에 그대로 바인드. ADR 0001 원칙.
    # 문제: 앱들이 거의 전부 3000에 하드코딩 → 이미 다른 프로젝트가 3000 점유 중이면
    #       모든 새 빌드의 QA가 EADDRINUSE로 실패 (2026-04-20 3건 연쇄 실패).
    # 현재 방식: 빈 포트를 골라 PORT env로 주입. 앱이 PORT를 존중하면 격리 성공.
    # 존중하지 않으면 기존 관찰 방식 폴백 — 단 하드코딩 포트가 점유 중이면 명시적
    # 에러로 유저에게 설명 (원인 명확화).
    qa_port = _find_free_port()
    env = {**os.environ, "PORT": str(qa_port)}

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
                # EADDRINUSE 감지 — 앱이 PORT env 무시하고 하드코딩한 포트를
                # 다른 프로세스가 점유 중인 경우. 유저에게 원인을 구체적으로.
                if "EADDRINUSE" in snippet:
                    import re as _re
                    m = _re.search(r":::?(\d+)", snippet) or _re.search(
                        r"address already in use\D+(\d+)", snippet, _re.I
                    )
                    hardcoded_port = m.group(1) if m else "알 수 없음"
                    gaps.append(
                        f"앱이 `PORT={qa_port}` 환경변수를 무시하고 포트 "
                        f"{hardcoded_port}에 직접 바인드하려다 실패했습니다 "
                        f"(EADDRINUSE — 이미 다른 프로세스가 그 포트를 사용 중)."
                    )
                    gaps.append(
                        "앱 코드에서 `app.listen(3000)` 같은 하드코딩 대신 "
                        "`app.listen(process.env.PORT || 3000)` 패턴을 써야 "
                        "배포 환경과 공존 가능합니다. 기획 대화로 돌아가 이 "
                        "점을 반영해 다시 빌드하거나, 이 빌드를 '다시 빌드'로 "
                        "재시도해주세요 (LLM이 다음 시도에 패턴을 바꿀 수 있음)."
                    )
                    return QaResult(
                        ok=False,
                        gaps=gaps,
                        detail=(
                            f"EADDRINUSE: 앱이 PORT={qa_port} 무시하고 "
                            f"{hardcoded_port}에 바인드 시도\n{snippet}"
                        ),
                    )
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

        # ---- 4. Primary endpoints: 라우트 스캔 + 프로브 ----
        scanned = _scan_routes(project_path)
        responsive, failed = _probe_primary_endpoints(observed, scanned)

        # ---- 5. Update 모드: 이전 버전과 비교해 regression 확인 ----
        regression_endpoints: list[str] = []
        if mode == "update" and project_id:
            previous = _load_previous_primary_endpoints(project_id)
            # 이전 버전에 있던 엔드포인트가 지금 실패(연결/5xx) 중이면 regression.
            regression_endpoints = [ep for ep in previous if ep in failed]
            if regression_endpoints:
                gaps.append(
                    "업데이트 후 기존 기능이 깨졌어요: "
                    + ", ".join(regression_endpoints)
                )
                return QaResult(
                    ok=False,
                    gaps=gaps,
                    detail=(
                        f"regression detected on {len(regression_endpoints)} endpoint(s): "
                        + ", ".join(regression_endpoints)
                    ),
                    observed_port=observed,
                    primary_endpoints=responsive,
                )

        return QaResult(
            ok=True,
            gaps=[],
            detail=(
                f"server responding on observed port {observed}; "
                f"primary_endpoints={len(responsive)}"
            ),
            observed_port=observed,
            primary_endpoints=responsive,
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
