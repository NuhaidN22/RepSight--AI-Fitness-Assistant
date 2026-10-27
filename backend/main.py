import os, re, json, uuid, base64, hashlib, hmac, secrets, socket, time, logging, datetime as dt
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Annotated
import dns.exception, dns.resolver
import db, coach, security, mailer, countries
from security import User, auth, seal, unseal, seal_bytes, unseal_bytes, rate_limit

log = logging.getLogger("repsight")
ROOT = os.path.join(os.path.dirname(__file__), "..")
UP = os.getenv("REPSIGHT_UPLOADS") or os.path.join(ROOT, "uploads"); os.makedirs(UP, exist_ok=True)
MAX_IMAGE = int(float(os.getenv("MAX_IMAGE_MB", "6" if db.IS_PG else "10")) * 1_000_000)   # the database is small on a free plan, so photos are capped lower there
app = FastAPI(title="RepSight", docs_url=None, redoc_url=None, openapi_url=None)  # no public API explorer
# Allow the separately-served frontend (Vite, Live Server, ...) to call this API from the browser.
DEV_ORIGINS = [f"http://{h}:{p}" for h in ("localhost", "127.0.0.1") for p in (5173, 5500, 3000, 4173, 8080)]
# Public web addresses allowed to call this API (comma-separated in .env, e.g. https://app.yourdomain.com), only needed when the website is served from a different address than this API.
DEV_ORIGINS += [o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"], allow_credentials=True)
if os.getenv("RENDER") and not db.IS_PG:
    # Render's disk is wiped on every restart and sleep, so a local SQLite file would silently lose every account and photo.
    raise RuntimeError("Running on Render without DATABASE_URL: set it to your Neon connection string, or all data would be lost on every restart")
db.init()
if os.getenv("LOGOUT_ON_START", "1") != "0":   # set LOGOUT_ON_START=0 on hosts that put the app to sleep and wake it again
    print(f"[auth] server started: signed out {security.end_all_sessions()} existing session(s), everyone must log in again")
else:
    print("[auth] server started: existing logins kept (LOGOUT_ON_START=0)")
print("[mail]", mailer.describe())
if os.getenv("APP_ENV") == "production":
    # Fail closed: in production a missing mail setup would mean sign-up codes get printed in server logs instead of emailed.
    if not mailer.configured(): raise RuntimeError("APP_ENV=production but no email is set up (BREVO_API_KEY and BREVO_SENDER_EMAIL, or MAIL_WEBHOOK_URL and MAIL_WEBHOOK_SECRET, or SMTP_HOST, SMTP_USER and SMTP_PASSWORD): refusing to start")
    if not os.getenv("ALLOWED_ORIGINS"): print("[cors] ALLOWED_ORIGINS is empty: only pages served from this same address may use the API (right for a single address; set it only if the website is on a different address)")
today = lambda: dt.date.today().isoformat()

_csp_cache: dict = {}

def csp() -> str:
    """Content-Security-Policy. The page's own inline script (the no-flash theme setter) is allowed by its hash, nothing else inline."""
    page = os.path.join(ROOT, "frontend-ts", "dist", "index.html")
    try: stamp = os.path.getmtime(page)
    except OSError: stamp = None
    if _csp_cache.get("stamp") != stamp or "value" not in _csp_cache:
        hashes = ""
        if stamp is not None:
            html = open(page, encoding="utf8").read()
            hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode() + "'"
                              for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S))
        _csp_cache.update(stamp=stamp, value=(f"default-src 'self'; script-src 'self' {hashes} https://cdn.jsdelivr.net 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; "
            "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"))
    return _csp_cache["value"]

@app.middleware("http")
async def protect(request: Request, call_next):
    # CSRF guard: a state-changing request from another website's origin is refused, whatever cookies the browser holds.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin not in DEV_ORIGINS and origin.split("://", 1)[-1] != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
    if not request.url.path.startswith("/formcheck"):  # that stand-alone page uses an inline script
        response.headers["Content-Security-Policy"] = csp()
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response

Name = Annotated[str, Field(min_length=1, max_length=80)]
class SetIn(BaseModel): exercise: Name; reps: int = Field(ge=1, le=1000); weight: float = Field(ge=0, le=2000); rpe: float | None = Field(default=None, ge=0, le=10)
class MetricIn(BaseModel): weight: float = Field(ge=20, le=500); height: float | None = Field(default=None, ge=50, le=260)
class FormIn(BaseModel): exercise: Name; reps: list[dict] = Field(max_length=300)   # exercise is required: no silent squat default
class RoutineItem(BaseModel): exercise: Name; sets: int = Field(default=3, ge=1, le=50); reps: int = Field(default=8, ge=1, le=1000)
class RoutineIn(BaseModel): name: Name; items: list[RoutineItem] = Field(max_length=60)
class ChatIn(BaseModel): message: str = Field(min_length=1, max_length=1000)
class AnalyzeIn(BaseModel): before_id: int; after_id: int
class IdentifyIn(BaseModel): frames: list[str] = Field(min_length=1, max_length=5)
class Credentials(BaseModel): username: str = Field(min_length=3, max_length=254); password: str = Field(min_length=8, max_length=128)   # an email, or an old plain username
class SignupStart(BaseModel):
    email: str = Field(max_length=254); password: str = Field(max_length=200); confirm_password: str = Field(max_length=200)
    age: int = Field(ge=-1000, le=1000); phone_country: str = Field(max_length=4); phone: str = Field(max_length=40)   # exact rules (and friendly messages) are checked in signup_start
class SignupVerify(BaseModel): email: str = Field(max_length=254); code: str = Field(pattern=r"^[0-9]{6}$"); password: str = Field(max_length=200)

# ---------------- accounts ----------------
def _claim_legacy(c, uid, key):
    """The first account adopts data from before accounts existed, and encrypts it with its own key."""
    if c.execute("SELECT COUNT(*) n FROM app_user").fetchone()["n"] != 1: return
    for t in db.OWNED_TABLES: c.execute(f"UPDATE {t} SET user_id=? WHERE user_id IS NULL", (uid,))
    for r in c.execute("SELECT id,content FROM coach_message WHERE user_id=?", (uid,)).fetchall():
        if r["content"] is not None and not r["content"].startswith(security.PREFIX): c.execute("UPDATE coach_message SET content=? WHERE id=?", (seal(key, r["content"]), r["id"]))
    for r in c.execute("SELECT id,metrics,summary FROM form_analysis WHERE user_id=?", (uid,)).fetchall():
        if r["metrics"] is not None and not r["metrics"].startswith(security.PREFIX): c.execute("UPDATE form_analysis SET metrics=?, summary=? WHERE id=?", (seal(key, r["metrics"]), seal(key, r["summary"]), r["id"]))
    for r in c.execute("SELECT id,path,caption FROM progress_photo WHERE user_id=? AND data IS NULL", (uid,)).fetchall():
        src = os.path.join(UP, os.path.basename(r["path"] or ""))
        if os.path.isfile(src):
            with open(src, "rb") as fh: blob = seal_bytes(key, fh.read()) if not src.endswith(".enc") else fh.read()
            c.execute("UPDATE progress_photo SET data=?, path=?, caption=? WHERE id=?", (blob, "db", seal(key, unseal(key, r["caption"]) if (r["caption"] or "").startswith(security.PREFIX) else r["caption"]), r["id"]))
            os.remove(src)

OTP_SECONDS = 600       # a code works for 10 minutes
OTP_TRIES = 5           # then it is burned and a new one must be requested
RESEND_SECONDS = 30

_dns_cache: dict[str, tuple[float, str | None]] = {}

def _resolve(domain: str, rtype: str):
    return dns.resolver.resolve(domain, rtype, lifetime=3.0)

def dns_check(domain: str) -> str | None:
    """Step 1 of sign-up: does this email domain really exist and accept mail? Returns a message for the user, or None when fine.
    It looks up the domain's MX records (its mail servers). A domain with no MX may still take mail on its own address (RFC 5321),
    so A/AAAA records count too. A lone '.' MX is a 'null MX' (RFC 7505): the domain says it takes no email at all.
    This cannot tell whether one particular mailbox exists: only the emailed code can."""
    now = time.monotonic()
    hit = _dns_cache.get(domain)
    if hit and now - hit[0] < 600: return hit[1]
    try:
        try:
            hosts = [str(r.exchange).rstrip(".") for r in _resolve(domain, "MX")]
            result = None if any(hosts) else "That email domain does not accept email"
        except dns.resolver.NoAnswer:
            result = "That email domain has no mail server"
            for rtype in ("A", "AAAA"):
                try: _resolve(domain, rtype); result = None; break
                except dns.resolver.NoAnswer: continue
    except (dns.resolver.NXDOMAIN, dns.name.EmptyLabel, dns.name.LabelTooLong, dns.name.NameTooLong):
        result = "That email domain does not exist"
    except (dns.exception.Timeout, dns.resolver.NoNameservers, dns.resolver.LifetimeTimeout, OSError):
        raise HTTPException(503, "We could not check your email domain right now. Please try again in a moment.")   # not cached
    _dns_cache[domain] = (now, result)
    return result

def clean_email(raw: str) -> str:
    email = raw.strip().lower()
    if not security.EMAIL_RE.match(email) or ".." in email: raise HTTPException(400, "Enter a valid email address")
    local, domain = email.split("@", 1)
    if security.is_reserved_domain(domain): raise HTTPException(400, f"{domain} is only a placeholder domain and cannot receive email. Use your own email address")
    fix = security.suggest_domain(domain)   # catches real-but-mistyped domains such as gmsil.com, which DNS would happily accept
    if fix: raise HTTPException(400, f"Did you mean {local}@{fix}? Check the spelling of your email")
    problem = dns_check(domain)
    if problem: raise HTTPException(400, problem)
    return email

@app.get("/api/meta/email-domains")
def email_domains():   # public on purpose: lets the sign-up form warn about a typo before anything is sent
    return {"popular": security.TYPO_TARGETS, "known": sorted(security.KNOWN_DOMAINS)}

@app.get("/api/meta/countries")
def country_list():   # public on purpose: the sign-up form needs it before anyone is logged in, and it is static data
    return countries.listing()

@app.post("/api/auth/signup/start")
def signup_start(s: SignupStart, request: Request):
    """Step 1: asks for an email + password, emails a 6-digit code. The account is NOT created until the code is entered.
    The answer is the same whether or not the email already has an account, so this cannot be used to look up who is registered."""
    ip = security.client_ip(request); rate_limit("signup-ip", ip, 6)
    email = clean_email(s.email); rate_limit("signup-email", email, 4)
    problem = security.password_error(s.password, s.confirm_password)
    if problem: raise HTTPException(400, problem)
    if not security.MIN_AGE <= s.age <= security.MAX_AGE: raise HTTPException(400, f"Age must be between {security.MIN_AGE} and {security.MAX_AGE}")
    phone, why = countries.normalize_phone(s.phone_country, s.phone)
    if not phone: raise HTTPException(400, why)
    now = int(time.time()); c = db.conn()
    c.execute("DELETE FROM pending_signup WHERE expires < ?", (now,))   # abandoned sign-ups do not pile up
    prev = c.execute("SELECT sent_at FROM pending_signup WHERE email=?", (email,)).fetchone()
    if prev and now - prev["sent_at"] < RESEND_SECONDS:
        c.close(); raise HTTPException(429, f"Please wait {RESEND_SECONDS} seconds before asking for another code")
    acct = security.new_account_secrets(s.password)          # done in both cases so the response time is the same
    if c.execute("SELECT 1 FROM app_user WHERE username=?", (email,)).fetchone():
        c.close()
        try: mailer.send(email, "RepSight: you already have an account", "Someone tried to sign up to RepSight with this email, but you already have an account. Log in instead. If this was not you, ignore this message.")
        except Exception: log.exception("mail failed")
        return {"sent": True, "dev": not mailer.configured()}
    code = f"{secrets.randbelow(10**6):06d}"; salt = os.urandom(16)
    check, ckey = security.code_keys(code, salt)
    profile = seal(ckey, json.dumps({"age": s.age, "phone": phone}))   # age and phone wait here sealed, never as plain text
    c.execute("DELETE FROM pending_signup WHERE email=?", (email,))   # a new code replaces any older one
    c.execute("INSERT INTO pending_signup(email,code_hash,code_salt,expires,attempts,sent_at,salt,pw_check,wrapped_key,profile) VALUES(?,?,?,?,0,?,?,?,?,?)",
              (email, check, salt, now + OTP_SECONDS, now, acct["salt"], acct["pw_check"], acct["wrapped_key"], profile))
    c.commit(); c.close()
    page = (f"<div style='font-family:Arial,sans-serif;max-width:420px'><h2 style='margin:0 0 8px'>Rep<span style='color:#e5383b'>Sight</span></h2>"
            f"<p>Your verification code is</p><p style='font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0'>{code}</p>"
            "<p style='color:#666'>It expires in 10 minutes. If you did not ask for it, ignore this message.</p></div>")
    try: mailer.send(email, f"{code} is your RepSight code", f"Your RepSight verification code is {code}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this message.", html=page)
    except Exception as error:
        log.error("could not send the sign-up email: %s", mailer.explain(error))
        c = db.conn(); c.execute("DELETE FROM pending_signup WHERE email=?", (email,)); c.commit(); c.close()
        raise HTTPException(502, "We could not send the email. Please try again later.")
    return {"sent": True, "dev": not mailer.configured()}

@app.post("/api/auth/signup/verify")
def signup_verify(v: SignupVerify, request: Request, response: Response):
    """Step 2: the right code proves the address exists and is yours. Only now is the account created, and the user is signed in.
    The password comes along so age and phone can be sealed under the user's own key straight away; the server never stores it."""
    rate_limit("verify-ip", security.client_ip(request), 20)
    email = v.email.strip().lower(); now = int(time.time()); c = db.conn()
    p = c.execute("SELECT * FROM pending_signup WHERE email=?", (email,)).fetchone()
    if not p or p["expires"] < now:
        c.execute("DELETE FROM pending_signup WHERE email=?", (email,)); c.commit(); c.close()
        raise HTTPException(400, "That code has expired. Ask for a new one.")
    if p["attempts"] >= OTP_TRIES:
        c.execute("DELETE FROM pending_signup WHERE email=?", (email,)); c.commit(); c.close()
        raise HTTPException(429, "Too many wrong codes. Ask for a new one.")
    check, ckey = security.code_keys(v.code, p["code_salt"])
    acct = {"salt": p["salt"], "pw_check": p["pw_check"], "wrapped_key": p["wrapped_key"]}
    key = security.verify_password(v.password, acct)
    details = unseal(ckey, p["profile"]) if hmac.compare_digest(check, p["code_hash"]) else None
    if details is None or key is None:   # same message whichever part was wrong
        c.execute("UPDATE pending_signup SET attempts=attempts+1 WHERE email=?", (email,)); c.commit(); c.close()
        raise HTTPException(400, "That code is not right")
    try:
        new_id = c.insert("INSERT INTO app_user(username,salt,pw_check,wrapped_key,profile) VALUES(?,?,?,?,?)", (email, acct["salt"], acct["pw_check"], acct["wrapped_key"], seal(key, details)))
    except Exception:
        c.close(); raise HTTPException(409, "This email already has an account. Log in instead.")
    c.execute("DELETE FROM pending_signup WHERE email=?", (email,))
    _claim_legacy(c, new_id, key); c.commit(); c.close()
    security.start_session(response, request, new_id, key)
    return {"username": email}

@app.post("/api/auth/login")
def login(cred: Credentials, request: Request, response: Response):
    name = cred.username.strip().lower()
    rate_limit("login-ip", security.client_ip(request), 10); rate_limit("login-user", name, 8)
    c = db.conn(); row = c.execute("SELECT * FROM app_user WHERE username=?", (name,)).fetchone(); c.close()
    # Do the same work whether or not the user exists, so response time does not reveal which usernames exist.
    key = security.verify_password(cred.password, row) if row else (security._derive(cred.password, b"\0" * 16) and None)
    if not row or key is None: raise HTTPException(401, "Wrong email or password")
    c = db.conn(); _claim_legacy(c, row["id"], key); c.commit(); c.close()   # no-op unless this is the only account and old data is waiting
    security.start_session(response, request, row["id"], key)
    return {"username": name}

@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    security.end_session(request, response); return {"ok": True}

@app.get("/api/auth/me")
def me(u: User = auth): return {"username": u.username}

# ---------------- workouts ----------------
@app.get("/api/exercises")
def exercises(u: User = auth):
    c = db.conn(); r = [dict(x) for x in c.execute("SELECT name,muscle FROM exercise ORDER BY name")]; c.close(); return r

@app.post("/api/sets")
def add_set(s: SetIn, u: User = auth):
    c = db.conn(); c.execute("INSERT INTO set_log(date,exercise,reps,weight,rpe,user_id) VALUES(?,?,?,?,?,?)", (today(), s.exercise, s.reps, s.weight, s.rpe, u.id)); c.commit(); c.close(); return {"ok": True}

@app.get("/api/sets")
def sets(exercise: str | None = None, u: User = auth):
    c = db.conn()
    q, a = ("SELECT * FROM set_log WHERE user_id=? AND exercise=? ORDER BY id DESC LIMIT 100", (u.id, exercise)) if exercise else ("SELECT * FROM set_log WHERE user_id=? ORDER BY id DESC LIMIT 100", (u.id,))
    r = [dict(x) for x in c.execute(q, a)]; c.close()
    for x in r: x.pop("user_id", None)
    return r

@app.post("/api/metrics")
def add_metric(m: MetricIn, u: User = auth):
    c = db.conn(); c.execute("INSERT INTO body_metric(date,weight,height,user_id) VALUES(?,?,?,?)", (today(), m.weight, m.height, u.id)); c.commit(); c.close(); return {"ok": True}

@app.post("/api/form")
def add_form(f: FormIn, u: User = auth):
    rate_limit("form", str(u.id), 30)
    n = len(f.reps) or 1
    flag_counts: dict[str, int] = {}
    for r in f.reps:
        for t in r.get("flags", []): flag_counts[str(t)[:80]] = flag_counts.get(str(t)[:80], 0) + 1
    num = lambda r, k, d: r.get(k, d) if isinstance(r.get(k, d), (int, float)) else d
    agg = {"rep_count": len(f.reps),
           "depth_pct": round(100 * sum(num(r, "depth_ok", 1) for r in f.reps) / n),    # % of reps reaching the target range
           "torso_pct": round(100 * sum(num(r, "torso_ok", 1) for r in f.reps) / n),    # % of reps with good posture
           "avg_tempo_s": round(sum(num(r, "tempo_s", 0) for r in f.reps) / n, 1),
           "flags": flag_counts, "depth_by_rep": [num(r, "depth_ok", 1) for r in f.reps], "reps": f.reps}
    score = round((agg["depth_pct"] + agg["torso_pct"]) / 2)
    llm_agg = {k: v for k, v in agg.items() if k not in ("reps", "depth_by_rep")}      # compact input keeps the model call cheap
    summary = coach.summarize_form(f.exercise, llm_agg)
    c = db.conn(); c.execute("INSERT INTO form_analysis(date,exercise,rep_count,score,metrics,summary,user_id) VALUES(?,?,?,?,?,?,?)",
        (today(), f.exercise, agg["rep_count"], score, seal(u.key, json.dumps(agg)), seal(u.key, summary), u.id)); c.commit(); c.close()
    return {"score": score, "summary": summary, "exercise": f.exercise, **agg}

@app.post("/api/identify")
def identify(a: IdentifyIn, u: User = auth):
    rate_limit("identify", str(u.id), 8)
    if any(len(f) > 700_000 for f in a.frames): raise HTTPException(413, "Frames too large")
    try:
        key, raw = coach.identify_exercise(a.frames)
    except Exception:
        log.exception("identify failed")
        raise HTTPException(502, "Exercise identification is unavailable right now")
    return {"exercise": key, "raw": raw}

@app.post("/api/coach")
def chat(m: ChatIn, u: User = auth):
    rate_limit("coach", str(u.id), 12)
    c = db.conn(); c.execute("INSERT INTO coach_message(role,content,user_id) VALUES('user',?,?)", (seal(u.key, m.message), u.id))
    hist = [{"role": r["role"], "content": unseal(u.key, r["content"]) or ""} for r in c.execute("SELECT role,content FROM coach_message WHERE user_id=? ORDER BY id DESC LIMIT 10", (u.id,))][::-1]
    c.commit(); c.close()
    def gen():
        out = []
        try:
            for t in coach.stream_reply(hist, u.id, u.key): out.append(t); yield t
        except Exception:
            log.exception("coach failed")
            yield "\n[The coach is unavailable right now. Please try again.]"
        c2 = db.conn(); c2.execute("INSERT INTO coach_message(role,content,user_id) VALUES('assistant',?,?)", (seal(u.key, "".join(out)), u.id)); c2.commit(); c2.close()
    return StreamingResponse(gen(), media_type="text/plain")

# ---------------- photos (stored encrypted, served only to their owner) ----------------
@app.post("/api/photos")
async def photo(request: Request, file: UploadFile = File(...), taken: str | None = Form(None), u: User = auth):
    rate_limit("upload", str(u.id), 20)
    try: day = dt.date.fromisoformat(taken).isoformat() if taken else today()
    except ValueError: raise HTTPException(400, "Date must look like 2026-10-08")
    data = await file.read(MAX_IMAGE + 1)   # never read more than the limit into memory
    if len(data) > MAX_IMAGE: raise HTTPException(413, f"Image too large (max {MAX_IMAGE // 1_000_000} MB)")
    if not security.sniff_image(data): raise HTTPException(400, "Photos must be real JPG, PNG or WEBP images. Videos go in the Kinetiq tab.")
    c = db.conn(); pid = c.insert("INSERT INTO progress_photo(date,path,caption,user_id,data) VALUES(?,?,?,?,?)", (day, "db", "", u.id, seal_bytes(u.key, data)))
    c.commit(); c.close(); return {"ok": True, "id": pid}

def live_photos(c, uid, key):
    """Details of this user's photos, never the image bytes. A row whose image is gone (an old file that was deleted) is dropped."""
    rows = [dict(x) for x in c.execute("SELECT id,date,path,caption,(data IS NOT NULL) AS has_data FROM progress_photo WHERE user_id=? ORDER BY id", (uid,))]
    keep = []
    for r in rows:
        if r["has_data"] or (r["path"] and r["path"] != "db" and os.path.exists(os.path.join(UP, os.path.basename(r["path"])))):
            keep.append({"id": r["id"], "date": r["date"], "path": f"/api/photos/{r['id']}/file", "caption": unseal(key, r["caption"]) or ""})
        else: c.execute("DELETE FROM progress_photo WHERE id=?", (r["id"],))
    c.commit(); return keep

def _read_photo(u: User, row):
    """The decrypted image of one of THIS user's photos, as (bytes, mime type)."""
    c = db.conn(); r = c.execute("SELECT data, path FROM progress_photo WHERE id=? AND user_id=?", (row["id"], u.id)).fetchone(); c.close()
    if not r: raise HTTPException(404, "Photo not found")
    if r["data"] is not None: raw = bytes(r["data"])
    else:   # an old photo that is still a file on disk
        try:
            with open(os.path.join(UP, os.path.basename(r["path"] or "")), "rb") as fh: raw = fh.read()
        except OSError: raise HTTPException(404, "Photo not found")
    plain = unseal_bytes(u.key, raw) if (r["data"] is not None or (r["path"] or "").endswith(".enc")) else raw
    mime = security.sniff_image(plain or b"")
    if not plain or not mime: raise HTTPException(404, "Photo not found")
    return plain, mime

@app.get("/api/photos/{pid}/file")
def photo_file(pid: int, u: User = auth):
    c = db.conn(); row = next((r for r in live_photos(c, u.id, u.key) if r["id"] == pid), None); c.close()
    if not row: raise HTTPException(404, "Photo not found")   # same answer for "not yours" and "does not exist"
    plain, mime = _read_photo(u, row)
    return Response(plain, media_type=mime, headers={"Cache-Control": "private, no-store"})

@app.post("/api/photos/analyze")
def analyze_photos(a: AnalyzeIn, u: User = auth):
    rate_limit("analyze", str(u.id), 6)
    if a.before_id == a.after_id: raise HTTPException(400, "Pick two different photos.")
    c = db.conn(); rows = {r["id"]: r for r in live_photos(c, u.id, u.key)}
    b, f = rows.get(a.before_id), rows.get(a.after_id)
    if not b or not f:
        c.close(); raise HTTPException(400, "One of the photos no longer exists.")
    if f["date"] < b["date"]:
        c.close(); raise HTTPException(400, "The After photo must be dated later than the Before photo.")
    try:
        text = coach.compare_photos(_read_photo(u, b), _read_photo(u, f), b["date"], f["date"], u.id, u.key)
    except HTTPException:
        c.close(); raise
    except Exception:
        c.close(); log.exception("photo analysis failed"); return {"caption": "Analysis is unavailable right now. Please try again."}
    c.execute("UPDATE progress_photo SET caption=? WHERE id=? AND user_id=?", (seal(u.key, text), f["id"], u.id)); c.commit(); c.close()
    return {"caption": text}

def _remove_files(names):
    """Deletes old-style photo files (new photos live in the database, so there is nothing to delete for them)."""
    for n in names:
        if n and n != "db":
            try: os.remove(os.path.join(UP, os.path.basename(n)))
            except OSError: pass

@app.delete("/api/photos")
def clear_photos(u: User = auth):
    c = db.conn(); names = [r["path"] for r in c.execute("SELECT path FROM progress_photo WHERE user_id=?", (u.id,))]
    c.execute("DELETE FROM progress_photo WHERE user_id=?", (u.id,)); c.commit(); c.close(); _remove_files(names); return {"ok": True}

@app.delete("/api/photos/{pid}")
def del_photo(pid: int, u: User = auth):
    c = db.conn(); r = c.execute("SELECT path FROM progress_photo WHERE id=? AND user_id=?", (pid, u.id)).fetchone()
    if r:
        _remove_files([r["path"]])
        c.execute("DELETE FROM progress_photo WHERE id=? AND user_id=?", (pid, u.id)); c.commit()
    c.close(); return {"ok": True}

@app.get("/api/photos")
def photos(u: User = auth):
    c = db.conn(); r = live_photos(c, u.id, u.key); c.close()
    return [{k: v for k, v in x.items() if not k.startswith("_")} for x in r]

def _wipe_user_data(uid):
    c = db.conn(); names = [r["path"] for r in c.execute("SELECT path FROM progress_photo WHERE user_id=?", (uid,))]
    for t in ("set_log", "body_metric", "form_analysis", "progress_photo", "coach_message"): c.execute(f"DELETE FROM {t} WHERE user_id=?", (uid,))
    c.execute("DELETE FROM routine_item WHERE routine_id IN (SELECT id FROM routine WHERE user_id=?)", (uid,)); c.execute("DELETE FROM routine WHERE user_id=?", (uid,))
    c.commit(); c.close(); _remove_files(names)

@app.delete("/api/data")
def wipe(u: User = auth):  # deletes the signed-in user's data only
    _wipe_user_data(u.id); return {"ok": True}

@app.delete("/api/account")
def delete_account(request: Request, response: Response, u: User = auth):
    _wipe_user_data(u.id)
    c = db.conn(); c.execute("DELETE FROM session WHERE user_id=?", (u.id,)); c.execute("DELETE FROM app_user WHERE id=?", (u.id,)); c.commit(); c.close()
    response.delete_cookie(security.COOKIE, path="/"); return {"ok": True}

# ---------------- routines ----------------
@app.post("/api/routines")
def add_routine(r: RoutineIn, u: User = auth):
    c = db.conn(); routine_id = c.insert("INSERT INTO routine(name,user_id) VALUES(?,?)", (r.name, u.id))
    for i in r.items:
        c.execute("INSERT INTO routine_item(routine_id,exercise,sets,reps) VALUES(?,?,?,?)", (routine_id, i.exercise, i.sets, i.reps))
    c.commit(); c.close(); return {"ok": True}

@app.get("/api/routines")
def routines(u: User = auth):
    c = db.conn(); out = []
    for r in c.execute("SELECT * FROM routine WHERE user_id=? ORDER BY id", (u.id,)).fetchall():
        items = [dict(x) for x in c.execute("SELECT exercise,sets,reps FROM routine_item WHERE routine_id=? ORDER BY id", (r["id"],))]
        out.append({"id": r["id"], "name": r["name"], "items": items})
    c.close(); return out

@app.delete("/api/routines/{rid}")
def del_routine(rid: int, u: User = auth):
    c = db.conn()
    if c.execute("SELECT 1 FROM routine WHERE id=? AND user_id=?", (rid, u.id)).fetchone():   # only your own routines
        c.execute("DELETE FROM routine_item WHERE routine_id=?", (rid,)); c.execute("DELETE FROM routine WHERE id=?", (rid,)); c.commit()
    c.close(); return {"ok": True}

@app.get("/api/summary")
def summary(u: User = auth):
    rate_limit("summary", str(u.id), 6)
    return {"summary": coach.weekly_summary(u.id, u.key)}

@app.get("/api/dashboard")
def dashboard(u: User = auth):
    c = db.conn(); week = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    vol = c.execute("SELECT COALESCE(SUM(reps*weight),0) v FROM set_log WHERE user_id=? AND date>=?", (u.id, week)).fetchone()["v"]
    prs = [dict(x) for x in c.execute("SELECT exercise, MAX(weight) weight FROM set_log WHERE user_id=? GROUP BY exercise ORDER BY weight DESC LIMIT 5", (u.id,))]
    wt = [dict(x) for x in c.execute("SELECT date,weight FROM body_metric WHERE user_id=? ORDER BY date,id", (u.id,))]
    ft = [dict(x) for x in c.execute("SELECT date,score FROM form_analysis WHERE user_id=? ORDER BY id", (u.id,))]
    h = c.execute("SELECT height FROM body_metric WHERE user_id=? AND height IS NOT NULL ORDER BY id DESC LIMIT 1", (u.id,)).fetchone()
    c.close()
    bmi = round(wt[-1]["weight"] / ((h["height"] / 100) ** 2), 1) if wt and h else None
    plateau = len(wt) >= 3 and abs(wt[-1]["weight"] - wt[-3]["weight"]) < 0.3
    return {"weekly_volume": vol, "prs": prs, "weight": wt, "form": ft, "plateau": plateau, "bmi": bmi}

# Photos are no longer a public folder: they are fetched through /api/photos/{id}/file, which checks the owner.
# Stand-alone form-check page (formcheck.html + repCounter.js). Looks in a few likely places and logs what it found.
# This mount must come BEFORE the "/" mount below, otherwise the catch-all would swallow the request.
_fc_options = [os.path.join(ROOT, *p) for p in (("frontend", "formcheck"), ("frontend-ts", "formcheck"), ("frontend-ts", "public", "formcheck"), ("formcheck",))]
_fc = next((d for d in _fc_options if os.path.isdir(d)), None)
if _fc:
    app.mount("/formcheck", StaticFiles(directory=_fc, html=True), name="formcheck")
    print(f"[formcheck] serving {_fc}  ->  http://localhost:8080/formcheck/formcheck.html  (files: {', '.join(os.listdir(_fc))})")
else:
    print("[formcheck] folder NOT found. Looked in:\n  " + "\n  ".join(_fc_options))

# Serve the first frontend build that exists: the TypeScript build, else the old plain HTML one.
for _d in ("frontend-ts/dist", "frontend"):
    _p = os.path.join(ROOT, _d)
    if os.path.isdir(_p):
        app.mount("/", StaticFiles(directory=_p, html=True), name="ui")
        break
