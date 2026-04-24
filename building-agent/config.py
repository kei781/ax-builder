"""Env loading for Building Agent. Reads the shared .env at repo root."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")


def env(key: str, default: str | None = None) -> str:
    val = os.environ.get(key)
    return val if val else (default or "")


def env_int(key: str, default: int) -> int:
    val = os.environ.get(key)
    if not val:
        return default
    try:
        return int(val)
    except ValueError:
        return default


class Settings:
    # Shared paths
    PROJECTS_BASE_DIR: str = env("PROJECTS_BASE_DIR", str(_ROOT / "projects"))
    # orchestrator의 SQLite DB. qa_supervisor가 ADR 0008 §D7 regression 검증
    # (이전 버전 primary_endpoints 로드)에서 read-only로 사용. 누락되어
    # 2026-04-24 update build 3회 연속 AttributeError로 죽었던 사고 후 추가.
    DB_PATH: str = env("DB_PATH", str(_ROOT / "data" / "ax-builder.db"))

    # LLM backend — only openai_compat supported in Step 5.
    # Ollama path will be added when Mac Studio lands.
    OPENAI_COMPAT_BASE_URL: str = env(
        "OPENAI_COMPAT_BASE_URL",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
    )
    OPENAI_COMPAT_API_KEY: str = env(
        "OPENAI_COMPAT_API_KEY", env("GEMINI_API_KEY", "")
    )

    # Slots used by Building Agent:
    #   - phase_planner → "deep" slot (better reasoning for structure)
    #   - qa_analysis   → "fast" slot (quick verdict)
    SLOT_PHASE_PLANNER: str = env("SLOT_DEEP", env("SLOT_CHAT", "gemini-2.5-flash"))
    SLOT_QA_ANALYSIS: str = env("SLOT_FAST", env("SLOT_CHAT", "gemini-2.5-flash"))

    # Timeouts
    CLAUDE_PHASE_TIMEOUT_S: int = env_int("CLAUDE_PHASE_TIMEOUT_S", 900)
    NPM_INSTALL_TIMEOUT_S: int = env_int("NPM_INSTALL_TIMEOUT_S", 300)
    QA_HEALTH_WAIT_S: int = env_int("QA_HEALTH_WAIT_S", 6)

    # Bounded phase count — prevents Hermes from producing a 20-phase plan
    MAX_PHASES: int = env_int("MAX_PHASES", 8)

    # Claude CLI binary (override if PATH munging is tricky)
    CLAUDE_BIN: str = env("CLAUDE_BIN", "claude")

    # QA deployment port (MVP: fixed). Step 7 will allocate via PortAllocator.
    QA_TEST_PORT: int = env_int("QA_TEST_PORT", 3999)


settings = Settings()
