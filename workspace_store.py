import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

TEHRAN = ZoneInfo("Asia/Tehran")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today() -> str:
    return datetime.now(TEHRAN).date().isoformat()


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class WorkspaceStore:
    def __init__(self, path: Path):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS watches (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
                    search TEXT NOT NULL, cursor TEXT NOT NULL,
                    next_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, checked TEXT, issue TEXT,
                    UNIQUE(owner, search)
                );
                CREATE TABLE IF NOT EXISTS alerts (
                    watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
                    token TEXT NOT NULL, ad TEXT NOT NULL, created TEXT NOT NULL,
                    seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(watch_id, token)
                );
                CREATE TABLE IF NOT EXISTS points (
                    search TEXT NOT NULL, day TEXT NOT NULL, sample TEXT NOT NULL,
                    PRIMARY KEY(search, day)
                );
                CREATE TABLE IF NOT EXISTS tracked (
                    owner TEXT NOT NULL, search TEXT NOT NULL, PRIMARY KEY(owner, search)
                );
                CREATE INDEX IF NOT EXISTS watches_due ON watches(next_at);
            """)
            if "lease_until" not in {
                row["name"] for row in db.execute("PRAGMA table_info(watches)")
            }:
                db.execute(
                    "ALTER TABLE watches ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0"
                )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        finally:
            db.close()

    def watches(self, owner: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT w.*, (SELECT COUNT(*) FROM alerts a WHERE a.watch_id=w.id AND a.seen=0) AS unread
                FROM watches w WHERE w.owner=? ORDER BY w.rowid DESC
            """,
                (owner,),
            ).fetchall()
        return [{**dict(row), "search": json.loads(row["search"])} for row in rows]

    def save_watch(self, owner: str, name: str, search: dict) -> str:
        key = encode(search)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT id FROM watches WHERE owner=? AND search=?", (owner, key)
            ).fetchone()
            if current:
                return current["id"]
            if (
                db.execute(
                    "SELECT COUNT(*) FROM watches WHERE owner=?", (owner,)
                ).fetchone()[0]
                >= 12
            ):
                raise ValueError("حداکثر ۱۲ جست‌وجوی ذخیره‌شده مجاز است.")
            watch_id = uuid4().hex
            db.execute(
                "INSERT INTO watches(id,owner,name,search,cursor) VALUES(?,?,?,?,?)",
                (watch_id, owner, name, key, stamp()),
            )
            return watch_id

    def delete_watch(self, owner, watch_id) -> bool:
        with self.connect() as db:
            return bool(
                db.execute(
                    "DELETE FROM watches WHERE owner=? AND id=?", (owner, watch_id)
                ).rowcount
            )

    def claim_watch(self, interval: int, owner=None, watch_id=None):
        now = int(time.time())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if watch_id:
                row = db.execute(
                    "SELECT * FROM watches WHERE id=? AND owner=?", (watch_id, owner)
                ).fetchone()
                if row and row["lease_until"] > now:
                    return None
            else:
                row = db.execute(
                    "SELECT * FROM watches WHERE next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 1",
                    (now, now),
                ).fetchone()
            if row:
                db.execute(
                    "UPDATE watches SET next_at=?, lease_until=? WHERE id=?",
                    (now + interval, now + 60, row["id"]),
                )
                return {**dict(row), "lease_until": now + 60}

    def finish_watch(self, watch, ads, cursor, issue=None, retry_in=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                "SELECT 1 FROM watches WHERE id=? AND lease_until=?",
                (watch["id"], watch["lease_until"]),
            ).fetchone():
                return
            db.executemany(
                "INSERT OR IGNORE INTO alerts(watch_id,token,ad,created) VALUES(?,?,?,?)",
                [
                    (watch["id"], ad["token"], encode(ad), stamp())
                    for ad in ads
                    if ad.get("token")
                ],
            )
            db.execute(
                "UPDATE watches SET cursor=?, checked=?, issue=?, lease_until=0 WHERE id=?",
                (cursor, stamp(), issue, watch["id"]),
            )
            if retry_in is not None:
                db.execute(
                    "UPDATE watches SET next_at=MIN(next_at, ?) WHERE id=?",
                    (int(time.time()) + retry_in, watch["id"]),
                )
            db.execute(
                "DELETE FROM alerts WHERE watch_id=? AND rowid NOT IN (SELECT rowid FROM alerts WHERE watch_id=? ORDER BY rowid DESC LIMIT 120)",
                (watch["id"], watch["id"]),
            )

    def alerts(self, owner: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT a.ad,a.created,a.seen,w.name FROM alerts a JOIN watches w ON w.id=a.watch_id
                WHERE w.owner=? ORDER BY a.created DESC, a.rowid DESC LIMIT 80
            """,
                (owner,),
            ).fetchall()
        return [{**dict(row), "ad": json.loads(row["ad"])} for row in rows]

    def mark_seen(self, owner: str) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE alerts SET seen=1 WHERE watch_id IN (SELECT id FROM watches WHERE owner=?)",
                (owner,),
            )

    def record(self, search: dict, market: dict) -> None:
        stats = (market.get("stats") or {}).get("price") or {}
        if stats.get("n") and stats.get("median"):
            with self.connect() as db:
                db.execute(
                    "INSERT OR REPLACE INTO points VALUES(?,?,?)",
                    (encode(search), today(), encode(stats)),
                )

    def history(self, search: dict) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT day,sample FROM points WHERE search=? ORDER BY day DESC LIMIT 90",
                (encode(search),),
            ).fetchall()
        return [
            {"day": row["day"], **json.loads(row["sample"])} for row in reversed(rows)
        ]

    def tracking(self, owner: str, search: dict, enabled: bool) -> None:
        key = encode(search)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not enabled:
                db.execute(
                    "DELETE FROM tracked WHERE owner=? AND search=?", (owner, key)
                )
                return
            existing = db.execute(
                "SELECT 1 FROM tracked WHERE owner=? AND search=?", (owner, key)
            ).fetchone()
            if (
                not existing
                and db.execute(
                    "SELECT COUNT(*) FROM tracked WHERE owner=?", (owner,)
                ).fetchone()[0]
                >= 8
            ):
                raise ValueError("حداکثر ۸ نمودار را می‌توان پایش کرد.")
            db.execute("INSERT OR IGNORE INTO tracked VALUES(?,?)", (owner, key))

    def tracked(self, owner: str) -> list[dict]:
        with self.connect() as db:
            return [
                json.loads(row[0])
                for row in db.execute(
                    "SELECT search FROM tracked WHERE owner=? ORDER BY rowid", (owner,)
                )
            ]

    def due_trends(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT DISTINCT t.search FROM tracked t
                WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.search=t.search AND p.day=?)
                LIMIT 12
            """,
                (today(),),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]
