import os, json
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
