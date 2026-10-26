"""Accounts, sessions, per-user encryption and rate limiting for RepSight.

Design in one paragraph: each user has a random data key. It is stored only in wrapped (encrypted) form:
once under a key derived from their password, and, while they are logged in, once per session under a key that
exists only in their browser cookie. So the database file alone cannot reveal photos, coach chats or form
summaries, and one user's key cannot open another user's data. Workout numbers stay readable by the server
(they are needed for the dashboard queries) but every row is tied to its owner and every query is scoped.
"""
import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, HTTPException, Request, Response

import db

MIN_PASSWORD = 8
MIN_AGE, MAX_AGE = 13, 120
COOKIE = "rs_session"
SESSION_SECONDS = 14 * 24 * 3600
# Lower-case email: 3-254 characters, local part up to 64 made of letters, digits and . _ % + - (no dot or dash at either end),
# then @, then dot-separated domain labels (letters, digits, inner hyphens; each up to 63) ending in a 2-24 letter or xn-- top-level domain.
EMAIL_RE = re.compile(
    r"^(?=.{3,254}$)(?=[^@]{1,64}@)(?!.*\.\.)"
    r"[a-z0-9](?:[a-z0-9._%+\-]*[a-z0-9])?"
    r"@(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9\-]{2,59})$"
)


@dataclass
class User:
    id: int
    username: str
    key: bytes  # this user's data key (Fernet key); only ever held in memory for the length of a request


def _b64(raw: bytes) -> bytes:
    return base64.urlsafe_b64encode(raw)


def _derive(password: str, salt: bytes) -> tuple[bytes, bytes]:
    """One scrypt run, split in two independent halves: a login check value and a key-wrapping key."""
    out = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return out[:32], out[32:]


def new_account_secrets(password: str) -> dict:
    salt = os.urandom(16)
    check, kek = _derive(password, salt)
    data_key = Fernet.generate_key()
    return {"salt": salt, "pw_check": check, "wrapped_key": Fernet(_b64(kek)).encrypt(data_key)}


def code_keys(code: str, salt: bytes) -> tuple[bytes, bytes]:
    """From the emailed code: a slow check value and a Fernet key. The key seals the sign-up details while they wait for the code,
    so even those are unreadable in the database (the code itself is never stored)."""
    out = hashlib.scrypt(code.encode(), salt=salt, n=2**14, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return out[:32], _b64(out[32:])


def verify_password(password: str, row) -> bytes | None:
    """Returns the user's data key when the password is right, else None."""
    check, kek = _derive(password, row["salt"])
    if not hmac.compare_digest(check, row["pw_check"]):
        return None
    try:
        return Fernet(_b64(kek)).decrypt(row["wrapped_key"])
    except InvalidToken:
        return None


def _session_key(token: str) -> bytes:
    return _b64(hashlib.sha256(b"sk:" + token.encode()).digest())


def _session_id(token: str) -> str:
    return hashlib.sha256(b"id:" + token.encode()).hexdigest()


def start_session(response: Response, request: Request, user_id: int, data_key: bytes) -> None:
    token = secrets.token_urlsafe(32)
    c = db.conn()
    c.execute("DELETE FROM session WHERE expires < ?", (int(time.time()),))
    c.execute("INSERT INTO session(id,user_id,wrapped_key,expires) VALUES(?,?,?,?)",
              (_session_id(token), user_id, Fernet(_session_key(token)).encrypt(data_key), int(time.time()) + SESSION_SECONDS))
    c.commit()
    c.close()
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https" or os.getenv("FORCE_SECURE_COOKIES") == "1", path="/")


def end_all_sessions() -> int:
    """Signs everyone out. Called every time the server starts, so a restart always means logging in again."""
    c = db.conn()
    n = c.execute("DELETE FROM session").rowcount
    c.commit()
    c.close()
    return n


def end_session(request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        c = db.conn()
        c.execute("DELETE FROM session WHERE id=?", (_session_id(token),))
        c.commit()
        c.close()
    response.delete_cookie(COOKIE, path="/")


def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Please log in")
    c = db.conn()
    row = c.execute("SELECT s.wrapped_key, s.expires, u.id, u.username FROM session s JOIN app_user u ON u.id=s.user_id WHERE s.id=?",
                    (_session_id(token),)).fetchone()
    c.close()
    if not row or row["expires"] < int(time.time()):
        raise HTTPException(401, "Please log in")
    try:
        key = Fernet(_session_key(token)).decrypt(row["wrapped_key"])
    except InvalidToken:
        raise HTTPException(401, "Please log in")
    return User(row["id"], row["username"], key)


auth = Depends(current_user)


# Domains that exist only as examples or for testing (RFC 2606 / 6761). They can never receive real mail, so sign-up refuses them.
RESERVED_DOMAINS = ("example.com", "example.org", "example.net", "example.edu")
RESERVED_TLDS = {"test", "example", "invalid", "localhost", "local", "localdomain", "internal"}


def is_reserved_domain(domain: str) -> bool:
    d = domain.lower().rstrip(".")
    return d.rsplit(".", 1)[-1] in RESERVED_TLDS or any(d == r or d.endswith("." + r) for r in RESERVED_DOMAINS)


# Big mail providers people mistype (gmial.com, gmsil.com, gmail.con ...). A domain that is NOT on the accepted list but is within a
# couple of keystrokes of one of these is probably a typo, so sign-up asks the user to check it.
POPULAR_DOMAINS = [
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "live.com", "aol.com", "protonmail.com", "proton.me",
    "rediffmail.com", "zoho.com", "gmx.com", "yandex.com", "mail.com", "msn.com", "ymail.com", "me.com",
]
# Real addresses that look like typos of the above but are genuine.
OTHER_REAL_DOMAINS = [
    "googlemail.com", "yahoo.in", "yahoo.co.in", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.ca", "yahoo.com.au", "yahoo.es", "yahoo.it",
    "outlook.in", "outlook.com.au", "outlook.fr", "outlook.de", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es",
    "live.in", "live.co.uk", "live.fr", "mac.com", "gmx.net", "gmx.de", "gmx.at", "mail.ru", "yandex.ru", "pm.me", "hey.com",
    "fastmail.com", "tutanota.com", "tuta.io", "hushmail.com", "protonmail.ch", "icloud.co",
]
OTHER_REAL_DOMAINS += """email.com sohu.com foxmail.com sina.com qq.com 163.com 126.com inbox.com inbox.lv rocketmail.com aim.com windowslive.com passport.com zohomail.in
    gmx.ch rediff.com sify.com in.com hotmail.co.in ymail.in naver.com daum.net hanmail.net seznam.cz wp.pl o2.pl onet.pl interia.pl att.net sbcglobal.net comcast.net verizon.net
    bellsouth.net cox.net earthlink.net charter.net juno.com optonline.net btinternet.com sky.com virginmedia.com talktalk.net orange.fr free.fr wanadoo.fr laposte.net sfr.fr web.de
    t-online.de freenet.de libero.it virgilio.it tiscali.it alice.it bluewin.ch bk.ru list.ru inbox.ru rambler.ru fastmail.fm mailfence.com runbox.com posteo.de mailbox.org
    hotmail.com.br bol.com.br uol.com.br terra.com.br ig.com.br yahoo.com.br yahoo.com.mx hotmail.com.mx yahoo.com.sg yahoo.com.ph yahoo.co.id yahoo.co.jp outlook.es outlook.it
    outlook.com.br outlook.sa outlook.jp outlook.kr live.fr""".split()
KNOWN_DOMAINS = set(POPULAR_DOMAINS) | set(OTHER_REAL_DOMAINS)
# Only long provider names are used as typo targets: short domains are too easily close to some other real domain.
TYPO_TARGETS = [d for d in POPULAR_DOMAINS if len(d) >= 9]


def edit_distance(a: str, b: str) -> int:
    """Keystroke distance: insert, delete, change or swap two neighbouring letters each count as 1 (gmial -> gmail is 1)."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1): d[i][0] = i
    for j in range(len(b) + 1): d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def suggest_domain(domain: str) -> str | None:
    """The popular domain this one is probably a typo of, or None (the domain is fine, or nothing is close)."""
    domain = domain.lower()
    if domain in KNOWN_DOMAINS:
        return None
    limit = 1 if len(domain) < 12 else 2   # one slip for ordinary names; two only for very long ones (hotmail.com, protonmail.com)
    best = min(TYPO_TARGETS, key=lambda p: edit_distance(domain, p))
    return best if edit_distance(domain, best) <= limit else None


def password_error(password: str, confirm: str | None = None) -> str | None:
    """None when the password is acceptable. Spaces never count: it needs 8 real characters, so '        ' is refused."""
    if len("".join(password.split())) < MIN_PASSWORD:
        return f"Password needs at least {MIN_PASSWORD} characters that are not spaces"
    if len(password) > 128:
        return "Password is too long (max 128 characters)"
    if confirm is not None and password != confirm:
        return "The two passwords do not match"
    return None


# ---- encryption helpers (per-user key) -------------------------------------------------------
PREFIX = "enc:"


def seal(key: bytes, text: str | None) -> str | None:
    if text is None:
        return None
    return PREFIX + Fernet(key).encrypt(text.encode()).decode()


def unseal(key: bytes, value: str | None) -> str | None:
    """Decrypts a sealed value. Legacy plaintext (no prefix) is returned as-is so old rows still read."""
    if value is None or not value.startswith(PREFIX):
        return value
    try:
        return Fernet(key).decrypt(value[len(PREFIX):].encode()).decode()
    except InvalidToken:
        return None


def seal_bytes(key: bytes, data: bytes) -> bytes:
    return Fernet(key).encrypt(data)


def unseal_bytes(key: bytes, data: bytes) -> bytes | None:
    try:
        return Fernet(key).decrypt(data)
    except InvalidToken:
        return None


# ---- rate limiting (in memory, per process) ---------------------------------------------------
_hits: dict[str, deque] = defaultdict(deque)
_lock = threading.Lock()


def rate_limit(bucket: str, who: str, limit: int, per_seconds: int = 60) -> None:
    now = time.monotonic()
    k = f"{bucket}:{who}"
    with _lock:
        q = _hits[k]
        while q and now - q[0] > per_seconds:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, "Too many requests. Please wait a moment and try again.")
        q.append(now)


def client_ip(request: Request) -> str:
    """The visitor's address, used for rate limits. Behind a reverse proxy (Render, Cloudflare, Caddy) every request arrives from the proxy, so with
    TRUST_PROXY=1 the first address in X-Forwarded-For (the real visitor) is used instead. Never turn it on when the app is reachable directly."""
    mode = os.getenv("TRUST_PROXY")
    if mode == "cloudflare":  # a Cloudflare tunnel: only Cloudflare can reach the app, and it sets this header to the real visitor
        real = (request.headers.get("cf-connecting-ip") or "").strip()
        if real:
            return real
    elif mode == "1":
        first = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


# ---- image sniffing ---------------------------------------------------------------------------
def sniff_image(data: bytes) -> str | None:
    """Returns the real image type from the file's first bytes, ignoring whatever name or type the client claimed."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None
