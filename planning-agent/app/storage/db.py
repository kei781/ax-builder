"""Shared SQLite access for the Planning Agent.

The orchestrator's TypeORM owns the schema (synchronize=true). We open the
same database file read/write from Python for the `project_memory` table and
for any future table we share. WAL journal mode lets the two writers coexist.

We open a **new connection per call** rather than a singleton because:
  - sqlite3.Connection objects are not thread-safe by default
  - Planning Agent runs tools on asyncio, which may schedule across threads
  - Connection open is cheap (~µs on local FS)
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from app.config import settings

_wal_set = False


def _ensure_wal(conn: sqlite3.Connection) -> None:
    """Set WAL journal mode once per process. Idempotent."""
    global _wal_set
    if _wal_set:
        return
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        _wal_set = True
    except sqlite3.Error:
        # Non-fatal — if orchestrator already opened in WAL this is harmless.
        pass


@contextmanager
def connection():
    """Context manager yielding a sqlite3 connection.

    The DB file must exist (orchestrator creates it on startup). If it's
    missing we raise to surface the misconfiguration early rather than
    creating an empty DB that would desync the schema.
    """
    path = Path(settings.DB_PATH)
    if not path.exists():
        raise FileNotFoundError(
            f"DB not found at {path}. Start the orchestrator first to create the schema."
        )
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    _ensure_wal(conn)
    try:
        yield conn
    finally:
        conn.close()
