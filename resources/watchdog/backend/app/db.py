from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Generator

# When running embedded inside OrianBuilder the main process sets WATCHDOG_DB_PATH
# to a per-user-data location so the database survives app updates and lives
# alongside the rest of the user's OrianBuilder state. When running standalone
# (e.g. `python -m uvicorn ...` from a checkout) we fall back to the legacy
# location: backend/watchdog.db next to this file.
_env_path = os.environ.get("WATCHDOG_DB_PATH")
if _env_path:
    DB_PATH = Path(_env_path)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    DB_PATH = BASE_DIR / "watchdog.db"


@contextmanager
def get_connection() -> Generator[sqlite3.Connection, None, None]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tracked_websites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                last_content_hash TEXT,
                summary TEXT,
                last_checked_text TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tracked_products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                current_price REAL,
                current_currency TEXT,
                target_price REAL,
                target_currency TEXT,
                image_url TEXT,
                rating REAL,
                rating_count INTEGER
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                price REAL NOT NULL,
                timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES tracked_products(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS website_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                website_id INTEGER NOT NULL,
                update_text TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (website_id) REFERENCES tracked_websites(id) ON DELETE CASCADE
            )
            """
        )

        # Migrations: add columns introduced after the original schema.
        _ensure_column(conn, "tracked_products", "current_currency", "TEXT")
        _ensure_column(conn, "tracked_products", "target_currency", "TEXT")
        _ensure_column(conn, "tracked_products", "image_url", "TEXT")
        _ensure_column(conn, "tracked_products", "rating", "REAL")
        _ensure_column(conn, "tracked_products", "rating_count", "INTEGER")
        _ensure_column(conn, "tracked_websites", "last_checked_text", "TEXT")

        conn.commit()


init_db()
