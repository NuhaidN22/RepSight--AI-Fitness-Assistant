import os, json, uuid, datetime as dt
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import db, coach

ROOT = os.path.join(os.path.dirname(__file__), "..")
UP = os.path.join(ROOT, "uploads"); os.makedirs(UP, exist_ok=True)
app = FastAPI(title="RepSight")
# Allow the separately-served frontend (Vite, Live Server, ...) to call this API from the browser.
DEV_ORIGINS = [f"http://{h}:{p}" for h in ("localhost", "127.0.0.1") for p in (5173, 5500, 3000, 4173)]
app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"])
db.init()
today = lambda: dt.date.today().isoformat()

class SetIn(BaseModel): exercise: str; reps: int; weight: float; rpe: float | None = None
class MetricIn(BaseModel): weight: float; height: float | None = None
class FormIn(BaseModel): exercise: str = Field(min_length=1); reps: list[dict]   # exercise is required: no silent squat default
class RoutineIn(BaseModel): name: str; items: list[dict]
class ChatIn(BaseModel): message: str
class AnalyzeIn(BaseModel): before_id: int; after_id: int
class IdentifyIn(BaseModel): frames: list[str] = Field(min_length=1, max_length=5)

@app.get("/api/exercises")
def exercises():
    c = db.conn(); r = [dict(x) for x in c.execute("SELECT name,muscle FROM exercise ORDER BY name")]; c.close(); return r

@app.post("/api/sets")
def add_set(s: SetIn):
    c = db.conn(); c.execute("INSERT INTO set_log(date,exercise,reps,weight,rpe) VALUES(?,?,?,?,?)", (today(), s.exercise, s.reps, s.weight, s.rpe)); c.commit(); c.close(); return {"ok": True}

@app.get("/api/sets")
def sets(exercise: str | None = None):
    c = db.conn()
    q, a = ("SELECT * FROM set_log WHERE exercise=? ORDER BY id DESC LIMIT 100", (exercise,)) if exercise else ("SELECT * FROM set_log ORDER BY id DESC LIMIT 100", ())
    r = [dict(x) for x in c.execute(q, a)]; c.close(); return r

@app.post("/api/metrics")
def add_metric(m: MetricIn):
    c = db.conn(); c.execute("INSERT INTO body_metric(date,weight,height) VALUES(?,?,?)", (today(), m.weight, m.height)); c.commit(); c.close(); return {"ok": True}

@app.post("/api/form")
def add_form(f: FormIn):
    n = len(f.reps) or 1
    flag_counts: dict[str, int] = {}
    for r in f.reps:
        for t in r.get("flags", []): flag_counts[t] = flag_counts.get(t, 0) + 1
    agg = {"rep_count": len(f.reps),
           "depth_pct": round(100 * sum(r.get("depth_ok", 1) for r in f.reps) / n),    # % of reps reaching the target range
           "torso_pct": round(100 * sum(r.get("torso_ok", 1) for r in f.reps) / n),    # % of reps with good posture
           "avg_tempo_s": round(sum(r.get("tempo_s", 0) for r in f.reps) / n, 1),
           "flags": flag_counts, "depth_by_rep": [r.get("depth_ok", 1) for r in f.reps], "reps": f.reps}
    score = round((agg["depth_pct"] + agg["torso_pct"]) / 2)
    llm_agg = {k: v for k, v in agg.items() if k not in ("reps", "depth_by_rep")}      # compact input keeps the model call cheap
    summary = coach.summarize_form(f.exercise, llm_agg)
    c = db.conn(); c.execute("INSERT INTO form_analysis(date,exercise,rep_count,score,metrics,summary) VALUES(?,?,?,?,?,?)",
        (today(), f.exercise, agg["rep_count"], score, json.dumps(agg), summary)); c.commit(); c.close()
    return {"score": score, "summary": summary, "exercise": f.exercise, **agg}

@app.post("/api/identify")
def identify(a: IdentifyIn):
    if any(len(f) > 700_000 for f in a.frames): raise HTTPException(413, "Frames too large")
    try:
        key, raw = coach.identify_exercise(a.frames)
    except Exception as e:
        raise HTTPException(502, f"Exercise identification failed: {e}")
    return {"exercise": key, "raw": raw}

@app.post("/api/coach")
def chat(m: ChatIn):
    c = db.conn(); c.execute("INSERT INTO coach_message(role,content) VALUES('user',?)", (m.message,))
    hist = [{"role": r["role"], "content": r["content"]} for r in c.execute("SELECT role,content FROM coach_message ORDER BY id DESC LIMIT 10")][::-1]
    c.commit(); c.close()
    def gen():
        out = []
        try:
            for t in coach.stream_reply(hist): out.append(t); yield t
        except Exception as e:
            yield f"\n[Coach error: {e}]"
        c2 = db.conn(); c2.execute("INSERT INTO coach_message(role,content) VALUES('assistant',?)", ("".join(out),)); c2.commit(); c2.close()
    return StreamingResponse(gen(), media_type="text/plain")

ALLOWED_IMG = {".jpg", ".jpeg", ".png", ".webp"}

@app.post("/api/photos")
async def photo(file: UploadFile = File(...), taken: str | None = Form(None)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_IMG or not (file.content_type or "").startswith("image/"):
        raise HTTPException(400, "Photos must be JPG, PNG or WEBP images. Videos go in the Kinetiq tab.")
    try: day = dt.date.fromisoformat(taken).isoformat() if taken else today()
    except ValueError: raise HTTPException(400, "Date must look like 2026-10-08")
    data = await file.read()
    if len(data) > 10_000_000: raise HTTPException(400, "Image too large (max 10 MB)")
    name = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(UP, name), "wb") as fh: fh.write(data)
    c = db.conn(); cur = c.execute("INSERT INTO progress_photo(date,path,caption) VALUES(?,?,?)", (day, f"/uploads/{name}", ""))
    c.commit(); pid = cur.lastrowid; c.close(); return {"ok": True, "id": pid}

def live_photos(c):
    rows = [dict(x) for x in c.execute("SELECT * FROM progress_photo ORDER BY id")]
    keep = []
    for r in rows:
        if os.path.exists(os.path.join(UP, os.path.basename(r["path"]))): keep.append(r)
        else: c.execute("DELETE FROM progress_photo WHERE id=?", (r["id"],))
    c.commit(); return keep

@app.post("/api/photos/analyze")
def analyze_photos(a: AnalyzeIn):
    if a.before_id == a.after_id: raise HTTPException(400, "Pick two different photos.")
    c = db.conn(); rows = {r["id"]: r for r in live_photos(c)}
    b, f = rows.get(a.before_id), rows.get(a.after_id)
    if not b or not f:
        c.close(); raise HTTPException(400, "One of the photos no longer exists.")
    if f["date"] < b["date"]:
        c.close(); raise HTTPException(400, "The After photo must be dated later than the Before photo.")
    path = lambda r: os.path.join(UP, os.path.basename(r["path"]))
    try:
        text = coach.compare_photos(path(b), path(f), b["date"], f["date"])
    except Exception as e:
        c.close(); return {"caption": f"Analysis failed: {e}"}
    c.execute("UPDATE progress_photo SET caption=? WHERE id=?", (text, f["id"])); c.commit(); c.close()
    return {"caption": text}

@app.delete("/api/photos")
def clear_photos():
    c = db.conn(); c.execute("DELETE FROM progress_photo"); c.commit(); c.close()
    for f in os.listdir(UP):
        try: os.remove(os.path.join(UP, f))
        except OSError: pass
    return {"ok": True}

@app.delete("/api/photos/{pid}")
def del_photo(pid: int):
    c = db.conn(); r = c.execute("SELECT path FROM progress_photo WHERE id=?", (pid,)).fetchone()
    if r:
        try: os.remove(os.path.join(UP, os.path.basename(r["path"])))
        except OSError: pass
        c.execute("DELETE FROM progress_photo WHERE id=?", (pid,)); c.commit()
    c.close(); return {"ok": True}

@app.get("/api/photos")
def photos():
    c = db.conn(); r = live_photos(c); c.close(); return r

@app.delete("/api/data")
def wipe():  # full deletion, per privacy plan
    c = db.conn()
    for t in ("set_log","body_metric","form_analysis","progress_photo","coach_message"): c.execute(f"DELETE FROM {t}")
    c.commit(); c.close()
    for f in os.listdir(UP): os.remove(os.path.join(UP, f))
    return {"ok": True}

@app.post("/api/routines")
def add_routine(r: RoutineIn):
    c = db.conn(); cur = c.execute("INSERT INTO routine(name) VALUES(?)", (r.name,))
    for i in r.items:
        c.execute("INSERT INTO routine_item(routine_id,exercise,sets,reps) VALUES(?,?,?,?)", (cur.lastrowid, i["exercise"], i.get("sets", 3), i.get("reps", 8)))
    c.commit(); c.close(); return {"ok": True}

@app.get("/api/routines")
def routines():
    c = db.conn(); out = []
    for r in c.execute("SELECT * FROM routine ORDER BY id").fetchall():
        items = [dict(x) for x in c.execute("SELECT exercise,sets,reps FROM routine_item WHERE routine_id=? ORDER BY id", (r["id"],))]
        out.append({"id": r["id"], "name": r["name"], "items": items})
    c.close(); return out

@app.delete("/api/routines/{rid}")
def del_routine(rid: int):
    c = db.conn(); c.execute("DELETE FROM routine_item WHERE routine_id=?", (rid,)); c.execute("DELETE FROM routine WHERE id=?", (rid,)); c.commit(); c.close(); return {"ok": True}

@app.get("/api/summary")
def summary(): return {"summary": coach.weekly_summary()}

@app.get("/api/dashboard")
def dashboard():
    c = db.conn(); week = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    vol = c.execute("SELECT COALESCE(SUM(reps*weight),0) v FROM set_log WHERE date>=?", (week,)).fetchone()["v"]
    prs = [dict(x) for x in c.execute("SELECT exercise, MAX(weight) weight FROM set_log GROUP BY exercise ORDER BY weight DESC LIMIT 5")]
    wt = [dict(x) for x in c.execute("SELECT date,weight FROM body_metric ORDER BY date,id")]
    ft = [dict(x) for x in c.execute("SELECT date,score FROM form_analysis ORDER BY id")]
    h = c.execute("SELECT height FROM body_metric WHERE height IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
    c.close()
    bmi = round(wt[-1]["weight"] / ((h["height"] / 100) ** 2), 1) if wt and h else None
    plateau = len(wt) >= 3 and abs(wt[-1]["weight"] - wt[-3]["weight"]) < 0.3
    return {"weekly_volume": vol, "prs": prs, "weight": wt, "form": ft, "plateau": plateau, "bmi": bmi}

app.mount("/uploads", StaticFiles(directory=UP), name="uploads")
# Stand-alone form-check page (formcheck.html + repCounter.js). Looks in a few likely places and logs what it found.
# This mount must come BEFORE the "/" mount below, otherwise the catch-all would swallow the request.
_fc_options = [os.path.join(ROOT, *p) for p in (("frontend", "formcheck"), ("frontend-ts", "formcheck"), ("frontend-ts", "public", "formcheck"), ("formcheck",))]
_fc = next((d for d in _fc_options if os.path.isdir(d)), None)
if _fc:
    app.mount("/formcheck", StaticFiles(directory=_fc, html=True), name="formcheck")
    print(f"[formcheck] serving {_fc}  ->  http://localhost:8000/formcheck/formcheck.html  (files: {', '.join(os.listdir(_fc))})")
else:
    print("[formcheck] folder NOT found. Looked in:\n  " + "\n  ".join(_fc_options))

# Serve the first frontend build that exists: the TypeScript build, else the old plain HTML one.
for _d in ("frontend-ts/dist", "frontend"):
    _p = os.path.join(ROOT, _d)
    if os.path.isdir(_p):
        app.mount("/", StaticFiles(directory=_p, html=True), name="ui")
        break