# AI Fitness Coach (NVIDIA x Nebius hackathon)
Live squat form feedback (on-device MediaPipe pose) -> stored metrics -> data-grounded coach (Nemotron on Nebius Token Factory).

## Run
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # add NEBIUS_API_KEY, confirm model IDs in the Token Factory catalog
cd backend && uvicorn main:app --reload
# open http://localhost:8000  (camera needs localhost or https)
```
Without a key the app runs in demo mode (fallback summaries, no coach).

## Architecture
Browser (HTML + MediaPipe Tasks, pose runs locally) -> FastAPI -> SQLite + uploads/ -> Nebius Token Factory (OpenAI-compatible).
Small model: form summaries. Larger model: coach chat (set via COACH_MODEL / SUMMARY_MODEL).

## Limits
Single-user (no auth), side-view squat only (knee valgus needs a front view), coaching not medical advice, no body-fat estimates.
