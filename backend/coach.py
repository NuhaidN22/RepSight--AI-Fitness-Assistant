import os, json, re, base64, mimetypes
from openai import OpenAI
from db import conn

COACH_MODEL = os.getenv("COACH_MODEL", "nvidia/Nemotron-3-Nano-30B-A3B")
SUMMARY_MODEL = os.getenv("SUMMARY_MODEL", COACH_MODEL)

def client():
    key = os.getenv("NEBIUS_API_KEY")
    if not key: return None
    return OpenAI(base_url=os.getenv("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1/"), api_key=key)

SYSTEM = """You are a concise, encouraging strength coach inside a fitness app.
Ground every answer in the USER DATA below; cite specific numbers/dates. If data is missing, say so and ask for it.
Guardrails: no medical diagnosis; for pain/injury advise seeing a professional; no extreme diets or crash weight loss;
never estimate body-fat from photos. Keep answers under 150 words with 1-3 concrete actions."""

def build_context():
    c = conn()
    sets = [dict(r) for r in c.execute("SELECT date,exercise,reps,weight,rpe FROM set_log ORDER BY id DESC LIMIT 40")]
    mets = [dict(r) for r in c.execute("SELECT date,weight,height FROM body_metric ORDER BY date DESC LIMIT 10")]
    forms = [dict(r) for r in c.execute("SELECT date,exercise,rep_count,score,metrics,summary FROM form_analysis ORDER BY id DESC LIMIT 5")]
    for f in forms: f["metrics"] = json.loads(f["metrics"])
    c.close()
    return json.dumps({"recent_sets": sets, "body_metrics": mets, "form_analyses": forms})

def stream_reply(history):
    cl = client()
    if not cl:
        yield "(Demo mode: set NEBIUS_API_KEY in .env to enable the coach.)"; return
    msgs = [{"role": "system", "content": SYSTEM + "\n\nUSER DATA:\n" + build_context()}] + history[-10:]
    for chunk in cl.chat.completions.create(model=COACH_MODEL, messages=msgs, stream=True, temperature=0.4, max_tokens=500):
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content

def summarize_form(exercise, agg):
    cl = client()
    flags = agg.get("flags") or {}
    issues = " Issues: " + ", ".join(f"{k} (x{v})" for k, v in flags.items()) + "." if flags else " No form issues detected."
    fallback = f"{exercise}: {agg['rep_count']} reps; target range reached on {agg['depth_pct']}% and posture OK on {agg['torso_pct']}% of reps." + issues
    if not cl: return fallback
    try:
        r = cl.chat.completions.create(model=SUMMARY_MODEL, max_tokens=200, temperature=0.3, messages=[
            {"role": "system", "content": f"You are a strength coach. The exercise is: {exercise}. depth_pct = % of reps reaching the target range of motion, torso_pct = % of reps with good posture, flags = form issues found with counts. Write 2-3 plain sentences about THIS exercise only: what went well, the main issue, and one concrete fix. Never mention squats unless the exercise is a squat. Not medical advice."},
            {"role": "user", "content": json.dumps(agg)}])
        return r.choices[0].message.content.strip()
    except Exception:
        return fallback

def weekly_summary():
    cl = client()
    if not cl: return "Demo mode: add NEBIUS_API_KEY to get an AI weekly summary."
    try:
        r = cl.chat.completions.create(model=SUMMARY_MODEL, max_tokens=250, temperature=0.3, messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "USER DATA:\n" + build_context() + "\n\nWrite my weekly training summary: volume/PR highlights, form trend, one thing to focus on next week."}])
        return r.choices[0].message.content.strip()
    except Exception as e:
        return f"Summary unavailable: {e}"

PHOTO_SYSTEM = """You compare two progress photos (BEFORE first, AFTER second) for a fitness app.
Reply in exactly this plain-text format, with no introduction and no mention of these instructions:
Visible changes: 2-3 short sentences about only what is visibly different (posture, visible muscle definition or fullness).
Reliability: 1-2 sentences on whether lighting, background, camera distance, angle or pose differ enough to make the comparison unreliable.
Next photo tip: one sentence on how to take a more comparable photo.
Rules: never estimate body-fat percentage, weight or health conditions; no medical claims; mention training data only as 'consistent with', never as proof; be cautious and encouraging; under 110 words in total."""

def _img_part(path):
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    with open(path, "rb") as f: b = base64.b64encode(f.read()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b}"}}

def compare_photos(before_path, after_path, d1, d2):
    cl = client(); model = os.getenv("VISION_MODEL")
    if not cl: return "Demo mode: add your API key to .env to enable photo analysis."
    if not model: return "Set VISION_MODEL in .env to an image-capable model (see README), then restart the server."
    content = [{"type": "text", "text": f"Photo 1 is BEFORE ({d1}). Photo 2 is AFTER ({d2}).\nTraining data: {build_context()}\nDescribe the visible changes."},
               _img_part(before_path), _img_part(after_path)]
    r = cl.chat.completions.create(model=model, max_tokens=500, temperature=0.3,
        messages=[{"role": "system", "content": PHOTO_SYSTEM}, {"role": "user", "content": content}])
    txt = re.sub(r"<think>.*?</think>", "", r.choices[0].message.content or "", flags=re.S).strip()
    txt = re.sub(r"^(okay|sure|here)[^\n]*:\s*\n+", "", txt, flags=re.I)  # drop chatty preamble
    return txt or "No description returned."

EXERCISE_KEYS = {"squat": "Squat / lunge / leg press", "hinge": "Deadlift / RDL / hip hinge", "pushup": "Push-up / dip",
                 "chestpress": "Chest press / bench press / pec fly", "curl": "Biceps curl", "raise": "Lateral or front dumbbell raise",
                 "press": "Overhead / shoulder press", "other": "Anything else (rows, shrugs, curls on a machine, ...)"}

def identify_exercise(frames):
    """Ask the vision model which exercise is shown in a few frames from one set. Returns (key, raw_text)."""
    cl = client(); model = os.getenv("VISION_MODEL")
    if not cl or not model: raise RuntimeError("VISION_MODEL / NEBIUS_API_KEY not set")
    options = "\n".join(f"{k}: {v}" for k, v in EXERCISE_KEYS.items())
    prompt = ("These frames come from ONE set of a gym exercise, in time order. Pick the exercise being performed by the "
              "main person (the one holding the weight or using the machine; ignore people in the background)."
              "\nOptions:\n" + options + "\nReply with ONLY the option key, one word.")
    content = [{"type": "text", "text": prompt}]
    for f in frames:
        content.append({"type": "image_url", "image_url": {"url": f if f.startswith("data:") else "data:image/jpeg;base64," + f}})
    r = cl.chat.completions.create(model=model, max_tokens=20, temperature=0, messages=[{"role": "user", "content": content}])
    txt = re.sub(r"<think>.*?</think>", "", r.choices[0].message.content or "", flags=re.S).strip().lower()
    key = next((k for k in EXERCISE_KEYS if re.search(rf"\b{k}\b", txt)), "other")
    return key, txt
