import itertools
import os
import sys
import tempfile

import pytest

_tmp = tempfile.mkdtemp(prefix="repsight_test_")
os.environ["REPSIGHT_DB"] = os.path.join(_tmp, "test.db")
os.environ["REPSIGHT_UPLOADS"] = os.path.join(_tmp, "uploads")
os.environ["NEBIUS_API_KEY"] = ""  # demo mode: tests never call the model or spend credits
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from fastapi.testclient import TestClient  # noqa: E402

import mailer  # noqa: E402
import main  # noqa: E402
import security  # noqa: E402

# No network in tests: the DNS check is replaced by a stub (the real one is tested separately in T12 with a fake resolver).
REAL_DNS_CHECK = main.dns_check
main.dns_check = lambda domain: "That email domain does not exist" if domain.endswith(".invalid") else None

# A valid 1x1 PNG.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082"
)
PASSWORD = "correct-horse-battery"
_ids = itertools.count(1)


def dump_db() -> bytes:
    """Everything the database holds, as raw bytes, so a test can prove a secret is not stored in readable form (either backend)."""
    import db
    if not db.IS_PG:
        return open(os.environ["REPSIGHT_DB"], "rb").read()
    out = []
    con = db.conn()
    for t in ("app_user", "session", "pending_signup", "set_log", "body_metric", "form_analysis", "progress_photo", "routine", "routine_item", "coach_message"):
        out += [repr(dict(r)).encode() for r in con.execute(f"SELECT * FROM {t}").fetchall()]
    con.close()
    return b"\n".join(out)


def new_client() -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False)


def last_code(email: str) -> str:
    """The 6-digit code from the newest email sent to this address (the outbox only fills when SMTP is not configured)."""
    mails = [m for m in mailer.OUTBOX if m["to"] == email]
    return mails[-1]["body"].split("code is ")[1][:6]


def signup_body(email: str, password: str = PASSWORD, **override) -> dict:
    return {"email": email, "password": password, "confirm_password": password, "age": 28, "phone_country": "IN", "phone": "98765 43210", **override}


def signup(c: TestClient, email: str, password: str = PASSWORD):
    """Runs the whole sign-up flow: request a code, read it from the outbox, verify it (which also signs the user in). Returns the verify response."""
    assert c.post("/api/auth/signup/start", json=signup_body(email, password)).status_code == 200
    return c.post("/api/auth/signup/verify", json={"email": email, "code": last_code(email), "password": password})


def new_user(prefix="user") -> TestClient:
    """A TestClient that is signed up and logged in as a brand-new user (has its own cookie jar)."""
    c = new_client()
    name = f"{prefix}{next(_ids)}@repsight-tests.dev"
    r = signup(c, name)
    assert r.status_code == 200, r.text
    c.username = name
    return c


@pytest.fixture(autouse=True)
def fresh_rate_limits():
    security._hits.clear()
    yield
    security._hits.clear()


@pytest.fixture()
def anon():
    return new_client()


@pytest.fixture()
def alice():
    return new_user("alice")


@pytest.fixture()
def bob():
    return new_user("bob")


def user_id(name: str) -> int:
    import db
    c = db.conn()
    uid = c.execute("SELECT id FROM app_user WHERE username=?", (name,)).fetchone()["id"]
    c.close()
    return uid
