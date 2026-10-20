# RepSight

An AI coach that watches your form and learns from your training data. Built for the NVIDIA x Nebius hackathon.

- **Log** workouts and build routines.
- **Kinetiq** (form check): upload a video or use the camera. Pose tracking runs in your browser, counts reps and gives plain-language feedback.
- **Sinew** (coach chat): Axon, our NVIDIA Nemotron model on Nebius, answers using your own logs, body metrics and form results.
- **Dashboard**: weekly volume, PRs, bodyweight and BMI, form score trend, plateau flag and an AI weekly summary.
- **Progress photos**: Before/After timeline, compare slider and a cautious AI comparison (no body-fat estimates).

## How it works

```
Browser (frontend-ts, Vite + TypeScript)
 ├─ MediaPipe PoseLandmarker (BlazePose full/heavy), runs on-device
 ├─ repCounter.ts: rep counting + per-exercise form rules on 3D joint angles
 └─ tracks one person at a time; tap the video to choose who
        │  JSON /api/*  (+ streamed text for the coach)
FastAPI (backend/) ── SQLite (app.db) + uploads/ (photos)
        │  OpenAI-compatible SDK
Nebius Token Factory
 ├─ Axon = NVIDIA Nemotron: Sinew coach chat, weekly and form summaries
 └─ Gemma 3 27B: names the exercise from 3 still frames; compares progress photos
```

**Kinetiq in detail**
- Pose gives joint positions only. A hysteresis state machine on one joint angle decides what a rep is.
- Presets: squat, deadlift/hinge, push-up, chest press, biceps curl, dumbbell raise, overhead press. Pick one from the dropdown, or leave it on Auto.
- On Auto, a vision model names the exercise from three frames. If that fails, the app falls back to locking onto the joint that moves the most. Knee and hip only count when the torso actually moves.
- Posture flags (torso lean, elbow drift, body line) are measured only on side-on frames.
- Per-rep results go to the backend, which counts the flags and has the LLM write a short summary for that exercise.

## Run locally

Requires Python 3.11+ and Node 20+.

```powershell
# 1. Backend (project root)
python -m venv .venv
.venv\Scripts\Activate.ps1          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env              # then add your NEBIUS_API_KEY
cd backend
uvicorn main:app --reload --port 8000

# 2. Frontend (second terminal)
cd frontend-ts
npm install
npm run dev                         # open http://localhost:5173
```

Vite forwards `/api` to the backend on port 8000. To serve everything from the backend instead, run `npm run build` in `frontend-ts` and open http://localhost:8000.

The camera works on `localhost` or https only. Uploading a video works anywhere.

Without an API key the app runs in demo mode: fallback summaries, no coach.

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `NEBIUS_API_KEY` | Nebius Token Factory key. Never commit it. |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1/` |
| `COACH_MODEL` | Coach chat, e.g. `nvidia/nemotron-3-super-120b-a12b` |
| `SUMMARY_MODEL` | Weekly and form summaries, e.g. `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` |
| `VISION_MODEL` | Image-capable model, e.g. `google/gemma-3-27b-it` (the NVIDIA models on Nebius do not accept images) |

## API

| Area | Endpoints |
| --- | --- |
| Workouts | `GET /api/exercises`, `GET`/`POST /api/sets`, `POST /api/metrics` |
| Routines | `GET`/`POST /api/routines`, `DELETE /api/routines/{id}` |
| Dashboard | `GET /api/dashboard`, `GET /api/summary` |
| Form check | `POST /api/form`, `POST /api/identify` |
| Coach | `POST /api/coach` (streamed) |
| Photos | `GET`/`POST /api/photos`, `DELETE /api/photos[/{id}]`, `POST /api/photos/analyze` |
| Reset | `DELETE /api/data` |

## Privacy

- Pose tracking and rep counting run in your browser.
- On **Auto**, three small still frames are sent to the vision model to name the exercise. Pick an exercise yourself and nothing is sent.
- Progress photos are sent to the vision model only when you press Analyze.
- `DELETE /api/data` wipes everything stored.

## Limits

- Single user, no login.
- Rep counting and form thresholds are starting estimates and have not been validated against labelled clips.
- Works best with a mostly side-on camera at about chest height and the whole body in frame. Machine exercises are partly hidden, so pick the exercise manually.
- Shrugs are not supported yet, and the app does not detect the dumbbell, bar or machine, only the body.
- Coaching suggestions, not medical advice. No body-fat estimates.
