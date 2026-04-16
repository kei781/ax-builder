"""Env loading + typed settings for the Planning Agent."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the ax-builder root if present. This allows a single .env
# file at the repository root to feed both orchestrator/ and planning-agent/.
_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_ROOT / ".env")
# Also load a local .env inside planning-agent/ if it exists, to allow
# per-service overrides during development.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def env(key: str, default: str | None = None) -> str | None:
    val = os.environ.get(key)
    if val is None or val == "":
        return default
    return val


def env_int(key: str, default: int) -> int:
    val = env(key)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        return default


class Settings:
    # HTTP server
    HOST: str = env("PLANNING_AGENT_HOST", "127.0.0.1") or "127.0.0.1"
    PORT: int = env_int("PLANNING_AGENT_PORT", 4100)

    # Filesystem + DB paths shared with the orchestrator.
    # Default to repo-relative paths resolved from planning-agent/app/.
    PROJECTS_BASE_DIR: str = (
        env("PROJECTS_BASE_DIR", str(_ROOT / "projects")) or str(_ROOT / "projects")
    )
    DB_PATH: str = (
        env("DB_PATH", str(_ROOT / "data" / "ax-builder.db"))
        or str(_ROOT / "data" / "ax-builder.db")
    )

    # Agent loop — max number of tool-call rounds per turn before forcing a
    # final text answer (safety net against runaway tool loops).
    MAX_TOOL_ITERATIONS: int = env_int("MAX_TOOL_ITERATIONS", 8)

    # History truncation — orchestrator side enforces this too, but we
    # apply it defensively on the agent side as well.
    MAX_HISTORY_MESSAGES: int = env_int("MAX_HISTORY_MESSAGES", 50)

    # LLM backend selection — see app/agent/llm/adapter.py
    LLM_BACKEND: str = env("LLM_BACKEND", "openai_compat") or "openai_compat"

    # OpenAI-compatible endpoint (Gemini, OpenRouter, etc.)
    OPENAI_COMPAT_BASE_URL: str = (
        env(
            "OPENAI_COMPAT_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        )
        or "https://generativelanguage.googleapis.com/v1beta/openai/"
    )
    OPENAI_COMPAT_API_KEY: str = env("OPENAI_COMPAT_API_KEY", env("GEMINI_API_KEY", "") or "") or ""

    # Ollama
    OLLAMA_BASE_URL: str = env("OLLAMA_BASE_URL", "http://127.0.0.1:11434") or "http://127.0.0.1:11434"

    # Idle timeout for lifecycle (ms). Ollama unloads models after this.
    IDLE_TIMEOUT_MS: int = env_int("IDLE_TIMEOUT_MS", 300_000)

    # Request timeout for LLM calls (s).
    LLM_TIMEOUT_S: int = env_int("LLM_TIMEOUT_S", 120)

    # Slots — each maps a role to a specific model name.
    # Required at minimum: SLOT_CHAT.
    SLOT_CHAT: str = env("SLOT_CHAT", "gemini-2.0-flash-exp") or "gemini-2.0-flash-exp"
    SLOT_SUMMARIZE: str = env("SLOT_SUMMARIZE", "gemini-2.0-flash-exp") or "gemini-2.0-flash-exp"
    SLOT_EVAL: str = env("SLOT_EVAL", "gemini-2.0-flash-exp") or "gemini-2.0-flash-exp"
    SLOT_TOOL_ARG: str = env("SLOT_TOOL_ARG", "gemini-2.0-flash-exp") or "gemini-2.0-flash-exp"


settings = Settings()
