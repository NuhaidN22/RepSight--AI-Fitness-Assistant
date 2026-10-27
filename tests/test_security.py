"""Security tests for RepSight. Each test states the property that SHOULD hold; a failure is a finding.

Tests that need data log in as real users first, so a test can never pass just because a request was refused."""
import os
import sqlite3

import pytest

from cryptography.fernet import Fernet

import coach
import db
import main
import security
import mailer
import dns.resolver
import countries
from conftest import PASSWORD, PNG, REAL_DNS_CHECK, dump_db, last_code, new_client, new_user, signup, signup_body, user_id

UPLOADS = lambda: os.environ["REPSIGHT_UPLOADS"]  # noqa: E731
DBFILE = lambda: os.environ["REPSIGHT_DB"]  # noqa: E731
PRIVATE_GETS = ["/api/sets", "/api/photos", "/api/dashboard", "/api/routines", "/api/summary", "/api/exercises", "/api/auth/me"]


def upload(client, name="a.png", data=PNG, ctype="image/png", taken="2026-10-01"):
    return client.post("/api/photos", files={"file": (name, data, ctype)}, data={"taken": taken})


# ---- T1 access control ---------------------------------------------------------------------
def test_t1_every_private_endpoint_requires_login(anon):
    open_ = [p for p in PRIVATE_GETS if anon.get(p).status_code != 401]
    assert not open_, f"reachable with no login: {open_}"


def test_t1_write_and_destructive_endpoints_require_login(anon):
    calls = [("post", "/api/sets", {"json": {"exercise": "x", "reps": 1, "weight": 1}}), ("delete", "/api/data", {}), ("delete", "/api/photos", {}),
             ("delete", "/api/account", {}), ("post", "/api/coach", {"json": {"message": "hi"}}), ("post", "/api/identify", {"json": {"frames": ["x"]}}),
             ("get", "/api/photos/1/file", {}), ("post", "/api/form", {"json": {"exercise": "x", "reps": []}})]
    bad = [f"{m} {p}" for m, p, kw in calls if getattr(anon, m)(p, **kw).status_code != 401]
    assert not bad, bad


def test_t1_forged_or_garbage_session_is_rejected(anon):
    anon.cookies.set(security.COOKIE, "not-a-real-token")
    assert anon.get("/api/sets").status_code == 401


def test_t1_login_error_does_not_reveal_which_usernames_exist(alice):
    c = new_client()
    wrong_pw = c.post("/api/auth/login", json={"username": alice.username, "password": "wrong-password-1"})
    no_user = c.post("/api/auth/login", json={"username": "nobody-here", "password": "wrong-password-1"})
    assert wrong_pw.status_code == no_user.status_code == 401 and wrong_pw.json() == no_user.json()


def test_t1_weak_passwords_rejected():
    assert start(new_client(), "weak@repsight-tests.dev", "short").status_code == 400


# ---- T2 user separation (IDOR) -------------------------------------------------------------
def test_t2_users_cannot_see_each_others_workouts(alice, bob):
    alice.post("/api/sets", json={"exercise": "AliceOnlyLift", "reps": 5, "weight": 100})
    assert any(s["exercise"] == "AliceOnlyLift" for s in alice.get("/api/sets").json()), "setup failed"
    assert not any(s["exercise"] == "AliceOnlyLift" for s in bob.get("/api/sets").json())
    assert bob.get("/api/dashboard").json()["weekly_volume"] == 0
    assert bob.get("/api/sets", params={"exercise": "AliceOnlyLift"}).json() == []


def test_t2_users_cannot_open_each_others_photos(alice, bob):
    pid = upload(alice).json()["id"]
    assert alice.get(f"/api/photos/{pid}/file").status_code == 200, "setup failed"
    assert bob.get(f"/api/photos/{pid}/file").status_code == 404
    assert bob.get("/api/photos").json() == []
    bob.delete(f"/api/photos/{pid}")
    assert alice.get(f"/api/photos/{pid}/file").status_code == 200, "bob deleted alice's photo"


def test_t2_users_cannot_touch_each_others_routines_or_data(alice, bob):
    alice.post("/api/routines", json={"name": "Alice plan", "items": [{"exercise": "Squat", "sets": 3, "reps": 5}]})
    rid = alice.get("/api/routines").json()[0]["id"]
    assert bob.get("/api/routines").json() == []
    bob.delete(f"/api/routines/{rid}")
    alice.post("/api/sets", json={"exercise": "Keep", "reps": 1, "weight": 1})
    bob.delete("/api/data")
    assert len(alice.get("/api/routines").json()) == 1 and len(alice.get("/api/sets").json()) == 1, "bob's actions reached alice's data"


def test_t2_cannot_analyze_someone_elses_photos(alice, bob):
    a, b = upload(alice, taken="2026-01-01").json()["id"], upload(alice, taken="2026-02-01").json()["id"]
    assert bob.post("/api/photos/analyze", json={"before_id": a, "after_id": b}).status_code == 400


def test_t2_coach_context_only_contains_own_data(alice, bob):
    alice.post("/api/sets", json={"exercise": "AliceMarkerLift", "reps": 5, "weight": 100})
    assert "AliceMarkerLift" in coach.build_context(user_id(alice.username), Fernet.generate_key()), "setup failed"
    assert "AliceMarkerLift" not in coach.build_context(user_id(bob.username), Fernet.generate_key())


def test_t2_logout_ends_the_session(alice):
    cookie = alice.cookies.get(security.COOKIE)
    assert alice.post("/api/auth/logout").status_code == 200
    again = new_client()
    again.cookies.set(security.COOKIE, cookie)
    assert again.get("/api/sets").status_code == 401, "old cookie still works after logout"


def test_t2_expired_session_is_rejected(alice):
    c = db.conn(); c.execute("UPDATE session SET expires=1"); c.commit(); c.close()
    assert alice.get("/api/sets").status_code == 401


# ---- T3 uploads ----------------------------------------------------------------------------
def test_t3_non_image_renamed_png_is_rejected(alice):
    assert upload(alice, "evil.png", b"MZ\x90\x00 not an image").status_code == 400


def test_t3_gif_and_svg_rejected_even_with_image_content_type(alice):
    assert upload(alice, "x.png", b"GIF89a....", "image/png").status_code == 400
    assert upload(alice, "x.svg", b"<svg onload=alert(1)/>", "image/svg+xml").status_code == 400


def test_t3_oversize_rejected(alice):
    assert upload(alice, "big.png", PNG + b"0" * 10_000_100).status_code == 413


def test_t3_client_file_name_is_never_used(alice):
    before = set(os.listdir(UPLOADS())) if os.path.isdir(UPLOADS()) else set()
    pid = upload(alice, "../../evil.png").json()["id"]
    con = db.conn(); row = con.execute("SELECT path FROM progress_photo WHERE id=?", (pid,)).fetchone(); con.close()
    assert row["path"] == "db" and "evil" not in str(dump_db()), "the client's file name must not be stored anywhere"
    assert (set(os.listdir(UPLOADS())) if os.path.isdir(UPLOADS()) else set()) == before, "nothing should be written to disk"


def test_t3_served_with_correct_type_and_no_cache(alice):
    pid = upload(alice).json()["id"]
    r = alice.get(f"/api/photos/{pid}/file")
    assert r.content == PNG and r.headers["content-type"] == "image/png" and "no-store" in r.headers["cache-control"]


# ---- T4 injection and traversal ------------------------------------------------------------
def test_t4_sql_injection_in_query_param(alice):
    alice.post("/api/sets", json={"exercise": "Squat", "reps": 5, "weight": 50})
    r = alice.get("/api/sets", params={"exercise": "' OR '1'='1"})
    assert r.status_code == 200 and r.json() == [], "injection returned rows"
    assert len(alice.get("/api/sets").json()) == 1


def test_t4_sql_injection_in_body_is_stored_as_plain_text(alice):
    evil = "x'); DROP TABLE set_log;--"
    assert alice.post("/api/sets", json={"exercise": evil, "reps": 1, "weight": 1}).status_code == 200
    assert [s["exercise"] for s in alice.get("/api/sets").json()] == [evil]
    con = db.conn(); n = con.execute("SELECT COUNT(*) AS n FROM set_log").fetchone()["n"]; con.close()
    assert n >= 1, "the table is gone or empty after the injection attempt"


def test_t4_username_injection(anon):
    assert anon.post("/api/auth/login", json={"username": "' OR 1=1 --", "password": "whatever-1234"}).status_code == 401
    assert start(anon, "a' or 'b@repsight-tests.dev").status_code == 400


def test_t4_path_traversal_static(anon):
    for url in ("/uploads/..%2f..%2fbackend%2fmain.py", "/uploads/../../.env", "/formcheck/..%2f..%2fbackend%2fdb.py", "/..%2fbackend%2fmain.py", "/%2e%2e/backend/main.py"):
        r = anon.get(url)
        assert "import os" not in r.text and "NEBIUS_API_KEY=" not in r.text, url


def test_t4_uploads_folder_is_not_served(anon, alice):
    upload(alice)
    for name in ("x.enc", "db", "x.png", "../app.db"):
        assert anon.get(f"/uploads/{name}").status_code == 404, name


# ---- T5 validation and abuse ---------------------------------------------------------------
def test_t5_rejects_nonsense_numbers(alice):
    for body in ({"exercise": "x", "reps": -5, "weight": 10}, {"exercise": "x", "reps": 10**9, "weight": 10},
                 {"exercise": "x", "reps": 5, "weight": -1}, {"exercise": "x", "reps": 5, "weight": 10, "rpe": 99}):
        assert alice.post("/api/sets", json=body).status_code == 422, body
    assert alice.post("/api/metrics", json={"weight": 5000}).status_code == 422


def test_t5_limits_text_length(alice):
    assert alice.post("/api/sets", json={"exercise": "A" * 100_000, "reps": 1, "weight": 1}).status_code == 422
    assert alice.post("/api/coach", json={"message": "A" * 1_000_000}).status_code == 422
    assert alice.post("/api/routines", json={"name": "x", "items": [{"exercise": "y"}] * 5000}).status_code == 422


def test_t5_limits_rep_list(alice):
    reps = [{"depth_ok": 1, "torso_ok": 1, "tempo_s": 1}] * 5000
    assert alice.post("/api/form", json={"exercise": "Squat", "reps": reps}).status_code == 422


def test_t5_form_tolerates_junk_in_rep_fields(alice):
    r = alice.post("/api/form", json={"exercise": "Squat", "reps": [{"depth_ok": "x", "torso_ok": None, "tempo_s": [1], "flags": [1, {"a": 1}]}]})
    assert r.status_code == 200


def test_t5_coach_is_rate_limited(alice):
    codes = [alice.post("/api/coach", json={"message": "hi"}).status_code for _ in range(20)]
    assert 429 in codes and codes[0] == 200, codes


def test_t5_login_is_rate_limited(alice):
    c = new_client()
    codes = [c.post("/api/auth/login", json={"username": alice.username, "password": "wrong-password-9"}).status_code for _ in range(15)]
    assert 429 in codes, "unlimited password guesses"


# ---- T6 headers, CORS, CSRF, errors --------------------------------------------------------
def test_t6_security_headers_present(anon):
    h = anon.get("/api/auth/me").headers
    assert h.get("x-content-type-options") == "nosniff" and h.get("x-frame-options") == "DENY"
    assert "default-src 'self'" in h.get("content-security-policy", "") and "no-store" in h.get("cache-control", "")


def test_t6_cors_blocks_foreign_origin(alice):
    r = alice.get("/api/sets", headers={"Origin": "https://evil.example"})
    assert r.headers.get("access-control-allow-origin") not in ("*", "https://evil.example")


def test_t6_cross_site_writes_are_refused(alice):
    r = alice.post("/api/sets", json={"exercise": "x", "reps": 1, "weight": 1}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and alice.get("/api/sets").json() == []


def test_t6_session_cookie_flags(anon):
    r = signup(anon, "cookieuser@repsight-tests.dev")
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_t6_api_docs_not_public(anon):
    assert all(anon.get(p).status_code == 404 for p in ("/docs", "/redoc", "/openapi.json"))


def test_t6_errors_do_not_leak_internals(alice):
    for r in (alice.post("/api/identify", json={"frames": ["data:image/png;base64,AAAA"]}),
              alice.post("/api/photos/analyze", json={"before_id": 1, "after_id": 2}),
              alice.get("/api/photos/99999/file")):
        assert "Traceback" not in r.text and 'File "' not in r.text and "NEBIUS" not in r.text and "VISION_MODEL" not in r.text, r.text


# ---- T7 data at rest -----------------------------------------------------------------------
def test_t7_chat_and_form_text_are_encrypted_in_the_database(alice):
    alice.post("/api/coach", json={"message": "UniqueSecretChatMessage"}).read()
    alice.post("/api/form", json={"exercise": "Squat", "reps": [{"depth_ok": 1, "torso_ok": 1, "tempo_s": 2, "flags": ["UniqueSecretFlag"]}]})
    raw = dump_db()
    assert b"UniqueSecretChatMessage" not in raw and b"UniqueSecretFlag" not in raw and b"target range reached" not in raw


def test_t7_passwords_are_never_stored(alice):
    raw = dump_db()
    assert PASSWORD.encode() not in raw


def test_t7_photos_are_encrypted_in_the_database(alice):
    upload(alice)
    con = db.conn(); blobs = [bytes(r["data"]) for r in con.execute("SELECT data FROM progress_photo WHERE data IS NOT NULL").fetchall()]; con.close()
    assert blobs, "no photo stored, so the test proved nothing"
    assert all(b != PNG and b"PNG" not in b[:64] for b in blobs)


def test_t7_other_users_key_cannot_decrypt(alice):
    pid = upload(alice).json()["id"]
    c = db.conn(); blob = bytes(c.execute("SELECT data FROM progress_photo WHERE id=?", (pid,)).fetchone()["data"]); c.close()
    assert security.unseal_bytes(Fernet.generate_key(), blob) is None


def test_t7_database_alone_cannot_open_a_session():
    """The session row holds the data key wrapped with a secret that only exists in the user's cookie."""
    c = new_user("carol")
    token = c.cookies.get(security.COOKIE)
    con = db.conn(); row = con.execute("SELECT wrapped_key FROM session WHERE user_id=? ORDER BY expires DESC LIMIT 1", (user_id(c.username),)).fetchone(); con.close()
    assert security.unseal_bytes(security._session_key("wrong-token"), row["wrapped_key"]) is None
    assert security.unseal_bytes(security._session_key(token), row["wrapped_key"]) is not None


# ---- T8 deletion ---------------------------------------------------------------------------
def _photo_rows(username):
    con = db.conn(); n = con.execute("SELECT COUNT(*) AS n FROM progress_photo WHERE user_id=? AND data IS NOT NULL", (user_id(username),)).fetchone()["n"]; con.close()
    return n


def test_t8_wipe_removes_own_rows_and_photos_only(alice, bob):
    upload(alice); upload(bob); alice.post("/api/sets", json={"exercise": "x", "reps": 1, "weight": 1})
    assert _photo_rows(alice.username) == 1 and _photo_rows(bob.username) == 1, "setup failed"
    alice.delete("/api/data")
    assert _photo_rows(alice.username) == 0, "alice's photos survived the wipe"
    assert _photo_rows(bob.username) == 1, "wipe deleted bob's photos"
    assert alice.get("/api/sets").json() == [] and alice.get("/api/photos").json() == [] and len(bob.get("/api/photos").json()) == 1


def test_t8_account_deletion_removes_user_sessions_and_files(alice):
    upload(alice)
    uid = user_id(alice.username)
    assert alice.delete("/api/account").status_code == 200
    con = db.conn()
    left = [con.execute(q, (uid,)).fetchone()[0] for q in ("SELECT COUNT(*) FROM app_user WHERE id=?", "SELECT COUNT(*) FROM session WHERE user_id=?", "SELECT COUNT(*) FROM progress_photo WHERE user_id=?")]
    con.close()
    assert left == [0, 0, 0] and alice.get("/api/sets").status_code == 401


# ---- T9 migration of pre-account data ------------------------------------------------------
@pytest.mark.skipif(db.IS_PG, reason="old single-user data only ever existed in the local SQLite file")
def test_t9_first_account_adopts_and_encrypts_legacy_data(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB", str(tmp_path / "legacy.db"))
    up = tmp_path / "up"; up.mkdir()
    monkeypatch.setattr(main, "UP", str(up))
    db.init()
    (up / "old.png").write_bytes(PNG)
    c = db.conn()
    c.execute("INSERT INTO set_log(date,exercise,reps,weight) VALUES('2026-01-01','LegacyLift',5,50)")
    c.execute("INSERT INTO coach_message(role,content) VALUES('user','LegacyChat')")
    c.execute("INSERT INTO progress_photo(date,path,caption) VALUES('2026-01-01','/uploads/old.png','')")
    secrets_ = security.new_account_secrets(PASSWORD)
    uid = c.insert("INSERT INTO app_user(username,salt,pw_check,wrapped_key) VALUES('legacyowner',?,?,?)", (secrets_["salt"], secrets_["pw_check"], secrets_["wrapped_key"]))
    key = security.verify_password(PASSWORD, secrets_)
    main._claim_legacy(c, uid, key); c.commit()
    assert c.execute("SELECT user_id FROM set_log").fetchone()[0] == uid
    assert c.execute("SELECT content FROM coach_message").fetchone()[0].startswith(security.PREFIX)
    assert "LegacyChat" not in open(db.DB, "rb").read().decode("latin1")
    assert os.listdir(up) == [], "the old photo file should have been moved into the database"
    blob = c.execute("SELECT data FROM progress_photo").fetchone()[0]
    assert blob and bytes(blob) != PNG and security.unseal_bytes(key, bytes(blob)) == PNG, "the photo must now be stored encrypted in the database"


# ---- T10 email sign-up with a one-time code ------------------------------------------------
def start(c, email, password=PASSWORD, **override):
    return c.post("/api/auth/signup/start", json=signup_body(email, password, **override))


def verify(c, email, code, password=PASSWORD):
    return c.post("/api/auth/signup/verify", json={"email": email, "code": code, "password": password})


def test_t10_account_is_not_created_until_the_code_is_entered(anon):
    assert start(anon, "pending1@repsight-tests.dev").status_code == 200
    assert anon.post("/api/auth/login", json={"username": "pending1@repsight-tests.dev", "password": PASSWORD}).status_code == 401
    assert verify(anon, "pending1@repsight-tests.dev", last_code("pending1@repsight-tests.dev")).status_code == 200
    assert anon.get("/api/auth/me").json()["username"] == "pending1@repsight-tests.dev", "verify should sign the user in"
    assert new_client().post("/api/auth/login", json={"username": "pending1@repsight-tests.dev", "password": PASSWORD}).status_code == 200


def test_t10_wrong_code_is_refused_and_burns_after_five_tries(anon):
    start(anon, "burn@repsight-tests.dev")
    good = last_code("burn@repsight-tests.dev")
    wrong = "000000" if good != "000000" else "111111"
    assert [verify(anon, "burn@repsight-tests.dev", wrong).status_code for _ in range(5)] == [400] * 5
    assert verify(anon, "burn@repsight-tests.dev", good).status_code in (400, 429), "the right code still worked after 5 wrong tries"


def test_t10_code_works_once_only(anon):
    start(anon, "once@repsight-tests.dev")
    code = last_code("once@repsight-tests.dev")
    assert verify(anon, "once@repsight-tests.dev", code).status_code == 200
    assert verify(anon, "once@repsight-tests.dev", code).status_code == 400


def test_t10_expired_code_is_refused(anon):
    start(anon, "late@repsight-tests.dev")
    c = db.conn(); c.execute("UPDATE pending_signup SET expires=1 WHERE email='late@repsight-tests.dev'"); c.commit(); c.close()
    assert verify(anon, "late@repsight-tests.dev", last_code("late@repsight-tests.dev")).status_code == 400


def test_t10_code_for_one_email_does_not_open_another(anon):
    start(anon, "mine@repsight-tests.dev"); start(anon, "yours@repsight-tests.dev")
    assert verify(anon, "yours@repsight-tests.dev", last_code("mine@repsight-tests.dev")).status_code == 400 or last_code("mine@repsight-tests.dev") == last_code("yours@repsight-tests.dev")


def test_t10_invalid_emails_and_domains_are_refused(anon):
    for bad in ("not-an-email", "a@b", "a@@repsight-tests.dev", "a b@repsight-tests.dev", "a@repsight-tests.dev\nBcc: x@y.com", "x" * 300 + "@repsight-tests.dev", "a..b@repsight-tests.dev", "a@nope.invalid"):
        security._hits.clear()  # each address is judged on its own, not by the per-IP sign-up limit
        assert start(anon, bad).status_code in (400, 422), bad


def test_t10_existing_email_gets_same_answer_and_no_second_account(anon, alice):
    r = start(anon, alice.username)
    assert r.status_code == 200 and r.json()["sent"] is True
    assert "already have an account" in [m for m in mailer.OUTBOX if m["to"] == alice.username][-1]["body"]
    c = db.conn(); n = c.execute("SELECT COUNT(*) FROM app_user WHERE username=?", (alice.username,)).fetchone()[0]; c.close()
    assert n == 1


def test_t10_cannot_ask_for_codes_in_a_rapid_stream(anon):
    assert start(anon, "spam@repsight-tests.dev").status_code == 200
    assert start(anon, "spam@repsight-tests.dev").status_code == 429


def test_t10_codes_and_passwords_are_not_stored_readably(anon):
    start(anon, "stored@repsight-tests.dev", "UniquePasswordForStoredTest1")
    code = last_code("stored@repsight-tests.dev")
    raw = dump_db()
    assert code.encode() not in raw and b"UniquePasswordForStoredTest1" not in raw
    assert b"98765" not in raw and b"43210" not in raw, "the phone number is readable while the sign-up waits for its code"


def test_t10_rest_of_app_still_refuses_unverified_users(anon):
    start(anon, "nocode@repsight-tests.dev")
    assert anon.get("/api/sets").status_code == 401


# ---- T11 required sign-up fields: password, confirm, age, phone ----------------------------
def test_t11_password_spaces_do_not_count(anon):
    for bad in ("        ", "a b c d e f g", "       x", "\t\t\t\t\t\t\t\t", "short", "1234567"):
        security._hits.clear()
        assert start(anon, "pw@repsight-tests.dev", bad).status_code == 400, repr(bad)
    security._hits.clear()
    assert start(anon, "pw@repsight-tests.dev", "abcdefgh").status_code == 200
    security._hits.clear()
    assert start(anon, "pw2@repsight-tests.dev", "pass word 12").status_code == 200  # spaces are allowed, they just do not count


def test_t11_passwords_must_match(anon):
    assert start(anon, "match@repsight-tests.dev", confirm_password="different-password-1").status_code == 400
    assert anon.post("/api/auth/signup/start", json={k: v for k, v in signup_body("m2@repsight-tests.dev").items() if k != "confirm_password"}).status_code == 422


def test_t11_age_rules(anon):
    for bad in (0, 12, 121, -5, 1000, 10**9):
        security._hits.clear()
        assert start(anon, "age@repsight-tests.dev", age=bad).status_code in (400, 422), bad
    for bad in ("abc", None, 25.5, True, ""):
        security._hits.clear()
        assert start(anon, "age@repsight-tests.dev", age=bad).status_code in (400, 422), repr(bad)
    for good in (13, 28, 120):
        security._hits.clear()
        assert start(anon, f"age{good}@repsight-tests.dev", age=good).status_code == 200, good


def test_t11_phone_rules(anon):
    for bad in ("", "   ", "abcdefg", "12345", "+", "98765 4321 x", "+91 98765 43210", "98765 43210; DROP TABLE app_user", "<script>", "98765432101234"):
        security._hits.clear()
        assert start(anon, "ph@repsight-tests.dev", phone=bad).status_code in (400, 422), repr(bad)
    for i, good in enumerate(("98765 43210", "(987) 654-3210", "9876543210", "098765 43210")):
        security._hits.clear()
        assert start(anon, f"ph{i}@repsight-tests.dev", phone=good).status_code == 200, good


def test_t11_every_field_is_required(anon):
    for field in ("email", "password", "confirm_password", "age", "phone_country", "phone"):
        body = signup_body("req@repsight-tests.dev"); body.pop(field)
        security._hits.clear()
        assert anon.post("/api/auth/signup/start", json=body).status_code == 422, field


def test_t11_age_and_phone_are_sealed_after_first_login_and_phone_never_reaches_the_model():
    c = new_user("profile")
    uid = user_id(c.username)
    con = db.conn(); row = con.execute("SELECT profile FROM app_user WHERE id=?", (uid,)).fetchone(); con.close()
    assert row["profile"].startswith(security.PREFIX), "age and phone are not stored sealed"
    con2 = db.conn(); cols = con2.columns("app_user"); con2.close()
    assert "age" not in cols and "phone" not in cols, "plain age/phone columns exist"
    raw = dump_db()
    assert b"98765" not in raw and b"43210" not in raw
    key = security.verify_password(PASSWORD, db.conn().execute("SELECT * FROM app_user WHERE id=?", (uid,)).fetchone())
    ctx = coach.build_context(uid, key)
    assert '"user_age": 28' in ctx and "98765" not in ctx, "age should reach the coach, the phone number must not"


def test_t11_verify_needs_the_password_chosen_at_sign_up(anon):
    start(anon, "pwcheck@repsight-tests.dev")
    code = last_code("pwcheck@repsight-tests.dev")
    assert verify(anon, "pwcheck@repsight-tests.dev", code, "some-other-password").status_code == 400
    assert anon.get("/api/auth/me").status_code == 401
    assert verify(anon, "pwcheck@repsight-tests.dev", code).status_code == 200


# ---- T12 country codes, email pattern and the DNS check ------------------------------------
def test_t12_country_list_is_public_and_complete(anon):
    r = anon.get("/api/meta/countries")
    assert r.status_code == 200 and len(r.json()) >= 50
    india = next(c for c in r.json() if c["code"] == "IN")
    assert india["dial"] == "91" and india["min"] == india["max"] == 10
    assert all({"code", "name", "dial", "min", "max"} <= set(c) for c in r.json())


def test_t12_phone_is_stored_with_its_country_code():
    cases = [("IN", "98765 43210", "+919876543210"), ("US", "(415) 555-2671", "+14155552671"), ("GB", "07911 123456", "+447911123456"),
             ("IN", "098765 43210", "+919876543210"), ("IN", "9198765 43210", "+919876543210")]
    for country, raw, expected in cases:
        assert countries.normalize_phone(country, raw) == (expected, None), (country, raw)


def test_t12_phone_length_is_checked_per_country(anon):
    for country, raw in (("IN", "98765 4321"), ("IN", "98765 432100"), ("US", "415 555 267"), ("AU", "4123 4567"), ("ZZ", "9876543210"), ("", "9876543210")):
        phone, why = countries.normalize_phone(country, raw)
        assert phone is None and why, (country, raw)
        security._hits.clear()
        assert start(anon, "cc@repsight-tests.dev", phone_country=country, phone=raw).status_code == 400, (country, raw)


def test_t12_every_country_entry_is_sane():
    seen = set()
    for code, name, dial, lo, hi in countries.COUNTRIES:
        assert code not in seen and dial.isdigit() and 1 <= lo <= hi <= 14 and len(dial) + hi <= 15 and name, code
        seen.add(code)


def test_t12_sealed_profile_holds_the_full_international_number():
    c = new_user("intl")
    con = db.conn(); row = con.execute("SELECT * FROM app_user WHERE username=?", (c.username,)).fetchone(); con.close()
    key = security.verify_password(PASSWORD, row)
    import json
    assert json.loads(security.unseal(key, row["profile"]))["phone"] == "+919876543210"


GOOD_EMAILS = ["a@b.co", "first.last@repsight-tests.dev", "user+tag@sub.example.org", "x_y-z@my-domain.io", "n1@xn--bcher-kva.example", "a.b.c@d.e.fg"]
BAD_EMAILS = ["plain", "@repsight-tests.dev", "a@", "a@b", "a@b.c", "a@@b.com", "a b@repsight-tests.dev", ".a@repsight-tests.dev", "a.@repsight-tests.dev", "a..b@repsight-tests.dev", "-a@repsight-tests.dev",
              "a@-example.com", "a@example-.com", "a@example..com", "a@example.c", "a@exa_mple.com", "a@repsight-tests.dev.", "a@example.123", "a@repsight-tests.dev\nBcc: x@y.com",
              "a'b@repsight-tests.dev", "a(b)@repsight-tests.dev", "a,b@repsight-tests.dev", "x" * 65 + "@repsight-tests.dev", "a@" + "x" * 64 + ".com", "a@" + ("x" * 60 + ".") * 5 + "com"]


def test_t12_email_pattern_accepts_good_and_rejects_bad():
    assert [e for e in GOOD_EMAILS if not security.EMAIL_RE.match(e)] == []
    assert [e for e in BAD_EMAILS if security.EMAIL_RE.match(e)] == []


def test_t12_email_pattern_is_enforced_by_the_endpoint(anon):
    for bad in BAD_EMAILS:
        security._hits.clear()
        assert start(anon, bad).status_code in (400, 422), bad[:40]


class _Answer:
    def __init__(self, host): self.exchange = host


def _fake_resolver(monkeypatch, table):
    """table maps (domain, record type) to a list of hosts, or to an exception class to raise."""
    def fake(domain, rtype):
        outcome = table.get((domain, rtype), dns.resolver.NoAnswer)
        if isinstance(outcome, type) and issubclass(outcome, Exception): raise outcome()
        return [_Answer(h) for h in outcome]
    monkeypatch.setattr(main, "_resolve", fake)
    main._dns_cache.clear()


def test_t12_dns_accepts_a_domain_with_mail_servers(monkeypatch):
    _fake_resolver(monkeypatch, {("good.com", "MX"): ["mx1.good.com."]})
    assert REAL_DNS_CHECK("good.com") is None


def test_t12_dns_rejects_a_domain_that_does_not_exist(monkeypatch):
    _fake_resolver(monkeypatch, {("nope.com", "MX"): dns.resolver.NXDOMAIN})
    assert "does not exist" in REAL_DNS_CHECK("nope.com")


def test_t12_dns_rejects_a_null_mx(monkeypatch):
    _fake_resolver(monkeypatch, {("nomail.com", "MX"): ["."]})
    assert "does not accept email" in REAL_DNS_CHECK("nomail.com")


def test_t12_dns_falls_back_to_the_domains_own_address(monkeypatch):
    _fake_resolver(monkeypatch, {("web.com", "A"): ["1.2.3.4"]})
    assert REAL_DNS_CHECK("web.com") is None
    _fake_resolver(monkeypatch, {("empty.com", "MX"): dns.resolver.NoAnswer})
    assert "no mail server" in REAL_DNS_CHECK("empty.com")


def test_t12_dns_outage_is_reported_not_treated_as_valid(monkeypatch):
    from fastapi import HTTPException
    import dns.exception
    _fake_resolver(monkeypatch, {("slow.com", "MX"): dns.exception.Timeout})
    try:
        REAL_DNS_CHECK("slow.com")
    except HTTPException as e:
        assert e.status_code == 503 and "slow.com" not in main._dns_cache
    else:
        raise AssertionError("a DNS timeout let the address through")


def test_t12_dns_answers_are_cached(monkeypatch):
    calls = []
    def counting(domain, rtype):
        calls.append(domain); return [_Answer("mx.cached.com.")]
    monkeypatch.setattr(main, "_resolve", counting); main._dns_cache.clear()
    REAL_DNS_CHECK("cached.com"); REAL_DNS_CHECK("cached.com")
    assert len(calls) == 1


def test_t12_signup_runs_the_dns_check_before_sending_any_email(anon, monkeypatch):
    before = len(mailer.OUTBOX)
    monkeypatch.setattr(main, "dns_check", lambda d: "That email domain does not exist")
    assert start(anon, "ghost@fake-domain.test").status_code == 400
    assert len(mailer.OUTBOX) == before, "an email was sent to an address whose domain failed the DNS check"


# ---- T13 phone length follows the country (no fixed 10-digit limit) ------------------------
def test_t13_each_country_uses_its_own_length():
    by = {c["code"]: c for c in countries.listing()}
    assert (by["IN"]["min"], by["IN"]["max"]) == (10, 10)
    assert (by["SG"]["min"], by["SG"]["max"]) == (8, 8) and (by["DE"]["min"], by["DE"]["max"]) == (6, 13)
    cases = [("SG", "9123 4567", "+6591234567"), ("SG", "91234 5678", None), ("BH", "3600 1234", "+97336001234"), ("FR", "612345678", "+33612345678"),
             ("DE", "1512 3456789", "+4915123456789"), ("DE", "15", None), ("IN", "98765 4321", None), ("IN", "98765 432101", None)]
    for country, raw, expected in cases:
        assert countries.normalize_phone(country, raw)[0] == expected, (country, raw)


def test_t13_endpoint_accepts_an_8_digit_number_where_that_is_right(anon):
    assert start(anon, "sg8@repsight-tests.dev", phone_country="SG", phone="91234 567").status_code == 200
    security._hits.clear()
    assert start(anon, "in8@repsight-tests.dev", phone_country="IN", phone="91234 567").status_code == 400


def test_t13_message_gives_the_countrys_real_length(anon):
    r = start(anon, "msg@repsight-tests.dev", phone="12345")
    assert r.status_code == 400 and "India have 10 digits" in r.json()["detail"]
    security._hits.clear()
    r = start(anon, "msg2@repsight-tests.dev", phone_country="DE", phone="12")
    assert r.status_code == 400 and "6 to 13 digits" in r.json()["detail"]


# ---- T14 mistyped email domains (gmsil.com) ------------------------------------------------
TYPOS = {"gmsil.com": "gmail.com", "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmaill.com": "gmail.com",
         "gmeil.com": "gmail.com", "yahho.com": "yahoo.com", "yaho.com": "yahoo.com", "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com",
         "outlok.com": "outlook.com", "outllook.com": "outlook.com", "iclod.com": "icloud.com", "protonmial.com": "protonmail.com", "yandxe.com": "yandex.com"}
REAL = ["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "yahoo.in", "outlook.com", "outlook.in", "hotmail.co.uk", "live.in", "icloud.com", "proton.me",
        "pm.me", "rediffmail.com", "mac.com", "me.com", "gmx.de", "mail.ru", "student.university.edu", "mycompany.com", "my-startup.io", "example.org", "nasa.gov", "bbc.co.uk",
        "gmail.co.in", "iitb.ac.in", "sub.domain.example.com", "fitness-coach.app"]


def test_t14_close_misspellings_are_flagged_with_the_right_suggestion():
    wrong = {d: security.suggest_domain(d) for d in TYPOS if security.suggest_domain(d) != TYPOS[d]}
    assert wrong == {}, wrong


def test_t14_real_domains_are_never_flagged():
    flagged = {d: security.suggest_domain(d) for d in REAL if security.suggest_domain(d)}
    assert flagged == {}, flagged


def test_t14_distance_counts_a_swap_as_one():
    assert security.edit_distance("gmial.com", "gmail.com") == 1
    assert security.edit_distance("gmsil.com", "gmail.com") == 1
    assert security.edit_distance("gmail.com", "gmail.com") == 0


def test_t14_endpoint_refuses_a_typo_and_names_the_fix(anon):
    for domain, fix in list(TYPOS.items())[:8]:
        security._hits.clear()
        r = start(anon, f"nuhaid@{domain}")
        assert r.status_code == 400 and f"nuhaid@{fix}" in r.json()["detail"], (domain, r.text)


def test_t14_a_typo_gets_no_email_and_no_pending_signup(anon):
    before = len(mailer.OUTBOX)
    assert start(anon, "nuhaid@gmsil.com").status_code == 400
    assert len(mailer.OUTBOX) == before
    con = db.conn(); n = con.execute("SELECT COUNT(*) FROM pending_signup WHERE email='nuhaid@gmsil.com'").fetchone()[0]; con.close()
    assert n == 0


def test_t14_endpoint_accepts_real_providers(anon):
    for i, domain in enumerate(("gmail.com", "yahoo.co.in", "hotmail.co.uk", "mycompany.com")):
        security._hits.clear()
        assert start(anon, f"real{i}@{domain}").status_code == 200, domain


def test_t14_domain_list_is_public_for_the_page(anon):
    r = anon.get("/api/meta/email-domains")
    assert r.status_code == 200 and "gmail.com" in r.json()["popular"] and "yahoo.co.in" in r.json()["known"]


# ---- T15 placeholder domains (example.com and friends) --------------------------------------
RESERVED = ["a@example.com", "a@EXAMPLE.COM", "a@mail.example.com", "a@example.org", "a@example.net", "a@example.edu", "a@deep.sub.example.com",
            "a@mydomain.test", "a@x.invalid", "a@host.localhost", "a@printer.local", "a@site.example", "a@corp.internal", "a@example.com."]
NOT_RESERVED = ["a@myexample.com", "a@example-shop.com", "a@examples.com", "a@example.co.uk", "a@notexample.org", "a@test.com", "a@testing.dev", "a@localhost.com"]


def test_t15_placeholder_domains_are_recognised():
    assert [d for d in RESERVED if not security.is_reserved_domain(d.split("@")[1])] == []
    assert [d for d in NOT_RESERVED if security.is_reserved_domain(d.split("@")[1])] == []


def test_t15_endpoint_refuses_placeholder_domains_before_any_lookup_or_email(anon, monkeypatch):
    def boom(domain): raise AssertionError("DNS was queried for a placeholder domain")
    monkeypatch.setattr(main, "dns_check", boom)
    before = len(mailer.OUTBOX)
    for address in RESERVED:
        security._hits.clear()
        r = start(anon, address.strip(".")) if not address.endswith(".") else start(anon, address)
        assert r.status_code == 400, address
    r = start(anon, "someone@example.com")
    assert "placeholder" in r.json()["detail"] and "example.com" in r.json()["detail"]
    assert len(mailer.OUTBOX) == before


def test_t15_similar_looking_real_domains_still_work(anon):
    for i, address in enumerate(NOT_RESERVED):
        security._hits.clear()
        assert start(anon, f"p{i}{address}").status_code == 200, address


# ---- T16 real email sending (against a fake mail server) -----------------------------------
import smtplib

import pytest


class FakeSMTP:
    """Stands in for the mail server: records what the app does and can be told to fail."""
    log: list = []
    fail_login: Exception | None = None
    ssl = False

    def __init__(self, host, port, timeout=None, context=None):
        FakeSMTP.log = [("connect", host, port, FakeSMTP.ssl)]
    def __enter__(self): return self
    def __exit__(self, *exc): return False
    def starttls(self, context=None): FakeSMTP.log.append(("starttls",))
    def login(self, user, password):
        FakeSMTP.log.append(("login", user, password))
        if FakeSMTP.fail_login: raise FakeSMTP.fail_login
    def send_message(self, msg): FakeSMTP.log.append(("send", msg))


@pytest.fixture()
def smtp(monkeypatch):
    FakeSMTP.log = []; FakeSMTP.fail_login = None; FakeSMTP.ssl = False
    for k, v in {"SMTP_HOST": "smtp.fake.test", "SMTP_PORT": "587", "SMTP_USER": "sender@fake.test", "SMTP_PASSWORD": "app-password-123", "SMTP_FROM": ""}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", type("S", (FakeSMTP,), {"ssl": True, "__init__": lambda self, h, p, timeout=None, context=None: setattr(FakeSMTP, "log", [("connect", h, p, True)])}))
    before = len(mailer.OUTBOX)
    yield FakeSMTP
    assert len(mailer.OUTBOX) == before, "a configured mailer must not use the local-dev outbox"


def _sent(fake):
    return next(e[1] for e in fake.log if e[0] == "send")


def test_t16_a_real_email_goes_through_starttls_login_and_send(anon, smtp):
    assert start(anon, "real@gmail.com").status_code == 200
    kinds = [e[0] for e in smtp.log]
    assert kinds == ["connect", "starttls", "login", "send"], kinds
    assert smtp.log[2][1:] == ("sender@fake.test", "app-password-123")
    msg = _sent(smtp)
    assert msg["To"] == "real@gmail.com" and msg["From"] == "sender@fake.test"
    body = msg.get_body(preferencelist=("plain",)).get_content()
    code = body.split("code is ")[1][:6]
    assert code.isdigit() and code in msg["Subject"] and "10 minutes" in body
    assert code in msg.get_body(preferencelist=("html",)).get_content(), "the HTML version should show the same code"


def test_t16_the_emailed_code_really_verifies_the_account(anon, smtp):
    start(anon, "mailed@gmail.com")
    code = _sent(smtp).get_body(preferencelist=("plain",)).get_content().split("code is ")[1][:6]
    assert verify(anon, "mailed@gmail.com", code).status_code == 200
    assert anon.get("/api/auth/me").json()["username"] == "mailed@gmail.com"


def test_t16_port_465_uses_ssl_instead_of_starttls(anon, smtp, monkeypatch):
    monkeypatch.setenv("SMTP_PORT", "465")
    assert start(anon, "ssl@gmail.com").status_code == 200
    assert smtp.log[0] == ("connect", "smtp.fake.test", 465, True) and "starttls" not in [e[0] for e in smtp.log]


def test_t16_from_address_can_be_set_separately(anon, smtp, monkeypatch):
    monkeypatch.setenv("SMTP_FROM", "RepSight <no-reply@fake.test>")
    start(anon, "from@gmail.com")
    assert _sent(smtp)["From"] == "RepSight <no-reply@fake.test>"


def test_t16_a_failed_login_gives_a_helpful_reason_and_no_half_finished_signup(anon, smtp):
    smtp.fail_login = smtplib.SMTPAuthenticationError(535, b"bad credentials")
    r = start(anon, "fail@gmail.com")
    assert r.status_code == 502 and "app-password-123" not in r.text and "smtp.fake" not in r.text
    con = db.conn(); n = con.execute("SELECT COUNT(*) FROM pending_signup WHERE email='fail@gmail.com'").fetchone()[0]; con.close()
    assert n == 0, "a pending sign-up was left behind although no email was sent"
    assert "App password" in mailer.explain(smtp.fail_login)


def test_t16_explanations_cover_the_common_failures(smtp):
    import socket, ssl as _ssl
    for error, hint in ((smtplib.SMTPAuthenticationError(535, b"x"), "App password"), (socket.gaierror("no host"), "Could not reach"),
                        (TimeoutError(), "Could not reach"), (_ssl.SSLError("bad"), "STARTTLS"), (smtplib.SMTPRecipientsRefused({}), "recipient"),
                        (smtplib.SMTPSenderRefused(550, b"x", "a@b.c"), "From address")):
        assert hint.lower() in mailer.explain(error).lower(), error


def test_t16_line_breaks_in_headers_are_refused(smtp):
    for to, subject in (("a@b.co\nBcc: evil@x.co", "hi"), ("a@b.co", "hi\r\nBcc: evil@x.co")):
        with pytest.raises(ValueError):
            mailer.send(to, subject, "body")
    assert not any(e[0] == "send" for e in smtp.log)


def test_t16_banner_reports_the_mode_without_the_password(smtp, monkeypatch):
    assert "smtp.fake.test:587" in mailer.describe() and "app-password-123" not in mailer.describe()
    monkeypatch.delenv("SMTP_PASSWORD")
    assert "DEV MODE" in mailer.describe()


# ---- T17 a server restart signs everyone out -----------------------------------------------
def test_t17_ending_all_sessions_logs_every_user_out(alice, bob):
    assert alice.get("/api/sets").status_code == 200 and bob.get("/api/sets").status_code == 200, "setup failed"
    assert security.end_all_sessions() >= 2
    assert alice.get("/api/sets").status_code == 401 and bob.get("/api/sets").status_code == 401
    assert alice.get("/api/auth/me").status_code == 401


def test_t17_logging_in_again_works_and_keeps_all_data(alice):
    alice.post("/api/sets", json={"exercise": "KeepMe", "reps": 5, "weight": 50})
    pid = upload(alice).json()["id"]
    security.end_all_sessions()
    again = new_client()
    assert again.post("/api/auth/login", json={"username": alice.username, "password": PASSWORD}).status_code == 200
    assert [s["exercise"] for s in again.get("/api/sets").json()] == ["KeepMe"]
    assert again.get(f"/api/photos/{pid}/file").content == PNG, "encrypted photo could not be read after logging in again"


def test_t17_startup_calls_it():
    import inspect
    assert "end_all_sessions()" in inspect.getsource(main).split("db.init()")[1].split("today =")[0], "main.py must sign everyone out at startup"


# ---- T18 running behind a reverse proxy -----------------------------------------
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_t18_rate_limits_use_the_real_visitor_behind_a_trusted_proxy(monkeypatch):
    from types import SimpleNamespace
    req = SimpleNamespace(headers={"x-forwarded-for": "203.0.113.7, 10.0.0.2"}, client=SimpleNamespace(host="10.0.0.2"))
    monkeypatch.delenv("TRUST_PROXY", raising=False)
    assert security.client_ip(req) == "10.0.0.2", "X-Forwarded-For must be ignored unless the proxy is trusted (it can be forged)"
    monkeypatch.setenv("TRUST_PROXY", "1")
    assert security.client_ip(req) == "203.0.113.7"
    assert security.client_ip(SimpleNamespace(headers={}, client=SimpleNamespace(host="10.0.0.2"))) == "10.0.0.2"


def test_t18_login_cookie_is_secure_when_forced(monkeypatch):
    monkeypatch.setenv("FORCE_SECURE_COOKIES", "1")
    r = signup(new_client(), "secure@gmail.com")
    assert "secure" in r.headers["set-cookie"].lower()


def test_t18_a_configured_public_origin_may_write_and_a_stranger_may_not(alice, monkeypatch):
    monkeypatch.setattr(main, "DEV_ORIGINS", main.DEV_ORIGINS + ["https://repsight.example-host.dev"])
    ok = alice.post("/api/sets", json={"exercise": "x", "reps": 1, "weight": 1}, headers={"Origin": "https://repsight.example-host.dev"})
    bad = alice.post("/api/sets", json={"exercise": "x", "reps": 1, "weight": 1}, headers={"Origin": "https://repsight.example-host.dev.evil.com"})
    assert ok.status_code == 200 and bad.status_code == 403


def _import_main(env_extra):
    env = {**os.environ, "REPSIGHT_DB": os.path.join(os.environ["REPSIGHT_DB"] + "_boot"), "REPSIGHT_UPLOADS": os.environ["REPSIGHT_UPLOADS"] + "_boot", **env_extra}
    return subprocess.run([sys.executable, "-c", "import main"], cwd=ROOT / "backend", env=env, capture_output=True, text=True, timeout=60)


def test_t18_production_refuses_to_start_without_email_or_public_address():
    base = {"APP_ENV": "production", "SMTP_HOST": "", "SMTP_USER": "", "SMTP_PASSWORD": "", "ALLOWED_ORIGINS": ""}
    r = _import_main(base)
    assert r.returncode != 0 and "SMTP" in r.stderr, "production started in dev-mail mode"
    r = _import_main({**base, "SMTP_HOST": "smtp.fake.test", "SMTP_USER": "a@fake.test", "SMTP_PASSWORD": "x"})
    assert r.returncode == 0, "one shared address needs no ALLOWED_ORIGINS"
    r = _import_main({**base, "SMTP_HOST": "smtp.fake.test", "SMTP_USER": "a@fake.test", "SMTP_PASSWORD": "x", "ALLOWED_ORIGINS": "https://repsight.example-host.dev"})
    assert r.returncode == 0, r.stderr[-400:]
    assert _import_main({"APP_ENV": ""}).returncode == 0, "local development must still start without any of this"


def test_t18_nothing_secret_ships_in_the_deploy_kit():
    for path in (ROOT / "deploy").glob("*"):
        text = path.read_text(encoding="utf8", errors="ignore")
        assert not re.search(r"(nvapi-|sk-)[A-Za-z0-9]{16,}", text), path
    assert ".env" in (ROOT / ".dockerignore").read_text() and "app.db" in (ROOT / ".dockerignore").read_text()
    assert "USER app" in (ROOT / "deploy" / "Dockerfile").read_text(), "the container must not run as root"


def test_t18_preflight_refuses_the_unedited_example_settings():
    r = subprocess.run([sys.executable, str(ROOT / "deploy" / "preflight.py"), str(ROOT / "deploy" / ".env.production.example")], capture_output=True, text=True)
    assert r.returncode == 1 and "no email set up" in r.stdout and "NEBIUS_API_KEY is empty" in r.stdout
    assert "nvapi" not in r.stdout, "preflight must never print secrets"


def test_t18_cloudflare_tunnel_uses_the_header_cloudflare_sets(monkeypatch):
    from types import SimpleNamespace
    req = SimpleNamespace(headers={"x-forwarded-for": "9.9.9.9", "cf-connecting-ip": "203.0.113.50"}, client=SimpleNamespace(host="127.0.0.1"))
    monkeypatch.setenv("TRUST_PROXY", "cloudflare")
    assert security.client_ip(req) == "203.0.113.50", "must ignore a forgeable X-Forwarded-For behind Cloudflare"
    monkeypatch.setenv("TRUST_PROXY", "1")
    assert security.client_ip(req) == "9.9.9.9"
    monkeypatch.delenv("TRUST_PROXY")
    assert security.client_ip(req) == "127.0.0.1", "headers must be ignored unless a proxy is declared"


def test_t18_preflight_accepts_a_single_address_setup_without_origins(tmp_path):
    env = tmp_path / ".env.production"
    env.write_text("API_DOMAIN=repsight-demo.trycloudflare.com\nAPP_ENV=production\nTRUST_PROXY=cloudflare\nFORCE_SECURE_COOKIES=1\nNEBIUS_API_KEY=abc\n"
                   "SMTP_HOST=smtp.gmail.com\nSMTP_USER=a@gmail.com\nSMTP_PASSWORD=pw\n", encoding="utf8")
    r = subprocess.run([sys.executable, str(ROOT / "deploy" / "preflight.py"), str(env)], capture_output=True, text=True)
    assert "ALLOWED_ORIGINS is empty: fine" in r.stdout


# ---- T19 email through a web relay (for hosts that block SMTP, such as Render's free tier) ---------
import http.server
import json as _json
import threading


class _Relay(http.server.BaseHTTPRequestHandler):
    """A fake Apps Script: checks the secret, records the message, and answers with a 302 like the real one."""
    seen: list = []
    secret = "relay-secret-0123456789-abcdef"

    def log_message(self, *a): pass

    def do_POST(self):
        if self.path == "/exec":
            body = _json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            ok = body.get("secret") == self.secret
            if ok: _Relay.seen.append(body)
            self.server.answer = {"ok": True} if ok else {"ok": False, "error": "wrong secret"}
            self.send_response(302); self.send_header("Location", "/result"); self.end_headers()
        else:
            self.send_response(404); self.end_headers()

    def do_GET(self):
        data = _json.dumps(getattr(self.server, "answer", {"ok": False})).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)


@pytest.fixture()
def relay(monkeypatch):
    _Relay.seen = []
    server = http.server.HTTPServer(("127.0.0.1", 0), _Relay)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"): monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("MAIL_WEBHOOK_URL", f"http://127.0.0.1:{server.server_port}/exec")
    monkeypatch.setenv("MAIL_WEBHOOK_SECRET", _Relay.secret)
    before = len(mailer.OUTBOX)
    yield server
    server.shutdown()
    assert len(mailer.OUTBOX) == before, "a configured relay must not use the local-dev outbox"


def test_t19_the_code_email_goes_through_the_relay_and_verifies_the_account(anon, relay):
    assert start(anon, "relay@gmail.com").status_code == 200
    assert len(_Relay.seen) == 1
    msg = _Relay.seen[0]
    assert msg["to"] == "relay@gmail.com" and "RepSight" in msg["subject"] and msg["secret"] == _Relay.secret
    code = msg["body"].split("code is ")[1][:6]
    assert code in msg["subject"] and code in msg["html"]
    assert verify(anon, "relay@gmail.com", code).status_code == 200


def test_t19_a_wrong_secret_is_reported_clearly_and_leaves_no_pending_signup(anon, relay, monkeypatch):
    monkeypatch.setenv("MAIL_WEBHOOK_SECRET", "not-the-right-secret-at-all-123456")
    r = start(anon, "wrongsecret@gmail.com")
    assert r.status_code == 502 and "secret" not in r.text.lower() and "script.google" not in r.text
    con = db.conn(); n = con.execute("SELECT COUNT(*) FROM pending_signup WHERE email='wrongsecret@gmail.com'").fetchone()[0]; con.close()
    assert n == 0 and _Relay.seen == []
    assert "SECRET" in mailer.explain(mailer.MailError("wrong secret"))


def test_t19_the_secret_is_never_sent_over_plain_http_to_a_real_host(monkeypatch):
    monkeypatch.setenv("MAIL_WEBHOOK_URL", "http://script.google.com/macros/s/abc/exec")
    monkeypatch.setenv("MAIL_WEBHOOK_SECRET", "x" * 30)
    with pytest.raises(mailer.MailError):
        mailer.send("a@gmail.com", "hi", "body")


def test_t19_relay_counts_as_configured_and_the_banner_hides_the_secret(relay):
    assert mailer.configured() and "web relay" in mailer.describe() and _Relay.secret not in mailer.describe()


def test_t19_unreachable_relay_gives_a_helpful_reason(anon, relay, monkeypatch):
    relay.shutdown(); relay.server_close()
    r = start(anon, "down@gmail.com")
    assert r.status_code == 502
    import urllib.error
    assert "Could not reach the mail service" in mailer.explain(urllib.error.URLError("refused"))


def test_t19_the_relay_script_ships_with_the_safety_checks():
    gs = (ROOT / "deploy" / "mail-relay.gs").read_text(encoding="utf8")
    assert "data.secret !== secret" in gs and "secret.length < 20" in gs and "bad address" in gs and "MailApp.sendEmail" in gs
    assert "AIza" not in gs and "https://script.google.com/macros/s/" not in gs, "no real URL or key may be committed"


# ---- T20 email through Brevo's web API (works on hosts that block SMTP) ---------------------------
class _FakeBrevo(http.server.BaseHTTPRequestHandler):
    seen: list = []
    key = "xkeysib-test-key-0123456789"
    mode = "ok"            # ok | bad_sender | rate

    def log_message(self, *a): pass

    def do_POST(self):
        body = _json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("api-key") != self.key:
            return self._answer(401, {"code": "unauthorized", "message": "Key not found"})
        if _FakeBrevo.mode == "ip_block":
            return self._answer(401, {"code": "unauthorized", "message": "We have detected you are using an unrecognised IP address 2001:db8::1. If you performed this action make sure to authorize it"})
        if _FakeBrevo.mode == "bad_sender":
            return self._answer(400, {"code": "invalid_parameter", "message": "Sender is not valid or not verified"})
        _FakeBrevo.seen.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        self._answer(201, {"messageId": "<fake@brevo>"})

    def _answer(self, status, data):
        raw = _json.dumps(data).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(raw)


@pytest.fixture()
def brevo(monkeypatch):
    _FakeBrevo.seen = []; _FakeBrevo.mode = "ok"
    server = http.server.HTTPServer(("127.0.0.1", 0), _FakeBrevo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_WEBHOOK_URL", "MAIL_WEBHOOK_SECRET"): monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("BREVO_API_URL", f"http://127.0.0.1:{server.server_port}/v3/smtp/email")
    monkeypatch.setenv("BREVO_API_KEY", _FakeBrevo.key)
    monkeypatch.setenv("BREVO_SENDER_EMAIL", "sender@gmail.com")
    before = len(mailer.OUTBOX)
    yield server
    server.shutdown()
    assert len(mailer.OUTBOX) == before, "a configured provider must not use the local-dev outbox"


def test_t20_code_email_goes_through_brevo_and_verifies_the_account(anon, brevo):
    assert start(anon, "brevo@gmail.com").status_code == 200
    assert len(_FakeBrevo.seen) == 1
    sent = _FakeBrevo.seen[0]
    assert sent["headers"]["api-key"] == _FakeBrevo.key and sent["headers"]["content-type"] == "application/json"
    msg = sent["body"]
    assert msg["sender"] == {"name": "RepSight", "email": "sender@gmail.com"} and msg["to"] == [{"email": "brevo@gmail.com"}]
    code = msg["textContent"].split("code is ")[1][:6]
    assert code in msg["subject"] and code in msg["htmlContent"]
    assert verify(anon, "brevo@gmail.com", code).status_code == 200


def test_t20_brevo_takes_priority_and_the_banner_hides_the_key(brevo, monkeypatch):
    monkeypatch.setenv("MAIL_WEBHOOK_URL", "https://script.google.com/macros/s/x/exec"); monkeypatch.setenv("MAIL_WEBHOOK_SECRET", "y" * 30)
    assert mailer.configured() and "Brevo" in mailer.describe() and _FakeBrevo.key not in mailer.describe()


def test_t20_a_wrong_key_gives_a_helpful_reason_but_never_shows_the_key(anon, brevo, monkeypatch):
    monkeypatch.setenv("BREVO_API_KEY", "xkeysib-WRONG-key-9999999999")
    r = start(anon, "wrongkey@gmail.com")
    assert r.status_code == 502 and "WRONG-key" not in r.text and "xkeysib" not in r.text
    con = db.conn(); n = con.execute("SELECT COUNT(*) FROM pending_signup WHERE email='wrongkey@gmail.com'").fetchone()[0]; con.close()
    assert n == 0, "a pending sign-up was left behind although no email was sent"
    with pytest.raises(mailer.MailError) as caught:
        mailer.send("a@gmail.com", "hi", "body")
    assert "401" in str(caught.value) and "WRONG-key" not in str(caught.value) and "WRONG-key" not in mailer.explain(caught.value)
    assert "BREVO_API_KEY" in mailer.explain(caught.value), "the explanation should name the setting to fix"


def test_t20_an_unverified_sender_is_explained(brevo):
    _FakeBrevo.mode = "bad_sender"
    with pytest.raises(mailer.MailError) as caught:
        mailer.send("a@gmail.com", "hi", "body")
    text = mailer.explain(caught.value)
    assert "Sender is not valid" in str(caught.value) and "verified" in text and "Senders" in text


def test_t20_the_key_is_never_sent_over_plain_http_to_a_real_host(monkeypatch):
    monkeypatch.setenv("BREVO_API_URL", "http://api.brevo.com/v3/smtp/email")
    monkeypatch.setenv("BREVO_API_KEY", "xkeysib-abc"); monkeypatch.setenv("BREVO_SENDER_EMAIL", "a@gmail.com")
    with pytest.raises(mailer.MailError):
        mailer.send("a@gmail.com", "hi", "body")


def test_t20_render_blueprint_asks_for_brevo_not_smtp():
    text = (ROOT / "render.yaml").read_text(encoding="utf8")
    assert "BREVO_API_KEY" in text and "BREVO_SENDER_EMAIL" in text and "SMTP_PASSWORD" not in text
    assert text.count("sync: false") >= 4 and not re.search(r"xkeysib-[A-Za-z0-9]{20,}", text), "a real key must never be committed"


def test_t20_brevo_ip_block_is_explained_in_plain_words(brevo):
    _FakeBrevo.mode = "ip_block"
    with pytest.raises(mailer.MailError) as caught:
        mailer.send("a@gmail.com", "hi", "body")
    text = mailer.explain(caught.value)
    assert "Authorised IPs" in text and "key is fine" in text and "Render" in text
