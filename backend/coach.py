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
    fallback = f"{agg['rep_count']} reps; depth hit on {agg['depth_pct']}% and torso OK on {agg['torso_pct']}% of reps."
    if not cl: return fallback
    try:
        r = cl.chat.completions.create(model=SUMMARY_MODEL, max_tokens=200, temperature=0.3, messages=[
            {"role": "system", "content": "You are a lifting coach. From the metrics JSON, write a 2-3 sentence plain-language form summary with one fix. Not medical advice."},
            {"role": "user", "content": json.dumps({"exercise": exercise, **agg})}])
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

PHOTO_SYSTEM = """You compare two progress photos for a fitness app. Describe only what is visibly different:
posture, visible muscle definition or fullness, framing/lighting/pose differences that limit the comparison.
Rules: NEVER estimate body-fat percentage, weight, or health conditions; no medical claims; be cautious and encouraging.
If the two photos differ in lighting, angle or distance, say the comparison is unreliable. Relate changes to the training data only as 'consistent with', never as proof.
Answer in under 120 words."""

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
    return re.sub(r"<think>.*?</think>", "", r.choices[0].message.content or "", flags=re.S).strip() or "No description returned."