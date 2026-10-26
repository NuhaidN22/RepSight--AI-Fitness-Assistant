"""Database access for RepSight.

Two backends behind one small interface, chosen by the environment:
  * DATABASE_URL set  -> PostgreSQL (for example a free Neon database). Used when the app runs on Render.
  * DATABASE_URL unset -> a local SQLite file (backend/app.db, or REPSIGHT_DB). Used for local development and most tests.

The rest of the app writes SQL once, with ? placeholders, and calls conn().execute / .insert / .commit / .close.
Rows work like dicts (row["name"], dict(row)) and also by position (row[0]) on both backends."""
import atexit
import os
import re
import sqlite3
import threading

DATABASE_URL = os.getenv("DATABASE_URL") or None
IS_PG = DATABASE_URL is not None
DB = os.getenv("REPSIGHT_DB") or os.path.join(os.path.dirname(__file__), "app.db")   # SQLite file; override lets tests use a throwaway database
EXERCISES = [("Back Squat","legs"),("Front Squat","legs"),("Goblet Squat","legs"),("Leg Press","legs"),("Lunge","legs"),("Romanian Deadlift","hamstrings"),("Deadlift","back"),("Leg Curl","hamstrings"),("Leg Extension","quads"),("Calf Raise","calves"),
("Bench Press","chest"),("Incline Bench Press","chest"),("Dumbbell Press","chest"),("Push-up","chest"),("Chest Fly","chest"),("Dip","chest"),
("Overhead Press","shoulders"),("Lateral Raise","shoulders"),("Face Pull","shoulders"),
("Pull-up","back"),("Lat Pulldown","back"),("Barbell Row","back"),("Seated Row","back"),("Dumbbell Row","back"),
("Biceps Curl","arms"),("Hammer Curl","arms"),("Triceps Pushdown","arms"),("Skull Crusher","arms"),
("Plank","core"),("Hanging Leg Raise","core"),("Hip Thrust","glutes")]

OWNED_TABLES = ("set_log", "body_metric", "form_analysis", "progress_photo", "routine", "coach_message")


class Row(dict):
    """A row that answers to row["name"], dict(row) and row[0], like sqlite3.Row does."""
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def _row_factory(cursor):
    names = [c.name for c in (cursor.description or [])]
    return lambda values: Row(zip(names, values))


_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            from psycopg_pool import ConnectionPool
            # prepare_threshold=None: works with Neon's pooled (pgbouncer) endpoint. check + max_idle: reconnect after Neon's auto-suspend.
            _pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=int(os.getenv("DB_POOL_MAX", "8")), timeout=20, max_idle=240,
                                   check=ConnectionPool.check_connection, kwargs={"row_factory": _row_factory, "prepare_threshold": None}, open=True)
        return _pool


def _close_pool():
    # Without this the pool's background threads keep a short-lived process (a script, a test) from ever exiting.
    if _pool is not None:
        _pool.close()


atexit.register(_close_pool)


def _to_pg(sql: str) -> str:
    """The app writes SQLite-flavoured SQL with ? placeholders; this rewrites it for PostgreSQL."""
    sql = sql.replace("%", "%%").replace("?", "%s")
    if re.match(r"\s*INSERT OR IGNORE INTO", sql, re.I):
        sql = re.sub(r"INSERT OR IGNORE INTO", "INSERT INTO", sql, count=1, flags=re.I) + " ON CONFLICT DO NOTHING"
    return sql


def _ddl_to_pg(sql: str) -> str:
    sql = sql.replace("INTEGER PRIMARY KEY", "BIGSERIAL PRIMARY KEY").replace(" REAL", " DOUBLE PRECISION").replace(" BLOB", " BYTEA")
    return sql.replace("TEXT DEFAULT CURRENT_TIMESTAMP", "TEXT DEFAULT (CURRENT_TIMESTAMP::text)")


class Conn:
    def __init__(self, raw):
        self.raw = raw

    def execute(self, sql, params=()):
        if IS_PG:
            cur = self.raw.cursor()
            cur.execute(_to_pg(sql), params)
            return cur
        return self.raw.execute(sql, params)

    def executemany(self, sql, seq):
        if IS_PG:
            cur = self.raw.cursor()
            cur.executemany(_to_pg(sql), seq)
            return cur
        return self.raw.executemany(sql, seq)

    def insert(self, sql, params=()):
        """Runs an INSERT into a table whose key is `id` and returns the new id (sqlite: lastrowid, Postgres: RETURNING id)."""
        if IS_PG:
            return self.execute(sql + " RETURNING id", params).fetchone()["id"]
        return self.raw.execute(sql, params).lastrowid

    def columns(self, table):
        if IS_PG:
            rows = self.execute("SELECT column_name AS n FROM information_schema.columns WHERE table_name=? AND table_schema=current_schema()", (table,)).fetchall()
            return {r["n"] for r in rows}
        return {r[1] for r in self.raw.execute(f"PRAGMA table_info({table})")}

    def commit(self):
        self.raw.commit()

    def close(self):
        if IS_PG:
            try:
                self.raw.rollback()   # nothing is kept unless commit() ran
            finally:
                _get_pool().putconn(self.raw)
        else:
            self.raw.close()


def conn() -> Conn:
    if IS_PG:
        return Conn(_get_pool().getconn())
    raw = sqlite3.connect(DB)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA secure_delete=ON")   # overwrite deleted or replaced data, so e.g. a phone number that was sealed does not linger in the file
    return Conn(raw)


def _run_ddl(c: Conn, script: str) -> None:
    for statement in (s.strip() for s in script.split(";")):
        if statement:
            c.execute(_ddl_to_pg(statement) if IS_PG else statement)


def init():
    c = conn()
    _run_ddl(c, """
    CREATE TABLE IF NOT EXISTS exercise(id INTEGER PRIMARY KEY, name TEXT UNIQUE, muscle TEXT);
    CREATE TABLE IF NOT EXISTS set_log(id INTEGER PRIMARY KEY, date TEXT, exercise TEXT, reps INT, weight REAL, rpe REAL);
    CREATE TABLE IF NOT EXISTS body_metric(id INTEGER PRIMARY KEY, date TEXT, weight REAL, height REAL);
    CREATE TABLE IF NOT EXISTS form_analysis(id INTEGER PRIMARY KEY, date TEXT, exercise TEXT, rep_count INT, score REAL, metrics TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS progress_photo(id INTEGER PRIMARY KEY, date TEXT, path TEXT, caption TEXT);
    CREATE TABLE IF NOT EXISTS routine(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS routine_item(id INTEGER PRIMARY KEY, routine_id INT, exercise TEXT, sets INT, reps INT);
    CREATE TABLE IF NOT EXISTS coach_message(id INTEGER PRIMARY KEY, ts TEXT DEFAULT CURRENT_TIMESTAMP, role TEXT, content TEXT);
    CREATE TABLE IF NOT EXISTS app_user(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt BLOB NOT NULL, pw_check BLOB NOT NULL, wrapped_key BLOB NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS pending_signup(email TEXT PRIMARY KEY, code_hash BLOB NOT NULL, code_salt BLOB NOT NULL, expires INT NOT NULL, attempts INT NOT NULL DEFAULT 0, sent_at INT NOT NULL, salt BLOB NOT NULL, pw_check BLOB NOT NULL, wrapped_key BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, user_id INT NOT NULL, wrapped_key BLOB NOT NULL, expires INT NOT NULL)
    """)
    # Columns added over time are added in place, so an existing database keeps working.
    # Every personal table has an owner. Rows from before accounts existed keep user_id NULL until the first account claims them.
    wanted = [(t, "user_id", "INT") for t in OWNED_TABLES] + [("pending_signup", "profile", "TEXT"), ("app_user", "profile", "TEXT"),
                                                               ("progress_photo", "data", "BLOB")]   # data = the encrypted photo itself (Render's disk is not kept)
    for table, column, kind in wanted:
        if column not in c.columns(table):
            c.execute(_ddl_to_pg(f"ALTER TABLE {table} ADD COLUMN {column} {kind}") if IS_PG else f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    for t in OWNED_TABLES:
        c.execute(f"CREATE INDEX IF NOT EXISTS idx_{t}_user ON {t}(user_id)")
    c.executemany("INSERT OR IGNORE INTO exercise(name,muscle) VALUES(?,?)", EXERCISES)
    c.commit()
    c.close()
