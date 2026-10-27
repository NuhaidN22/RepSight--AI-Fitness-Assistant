# Deploying RepSight

Pick one. All three run the same app; they differ in where it lives and what it costs.

| | Cost | Always on? | Stable address? | Effort |
| --- | --- | --- | --- | --- |
| **1. Render + Neon (recommended)** | free | yes, but sleeps after 15 min idle (about 1 minute to wake) | yes, `https://<name>.onrender.com` | about 20 minutes |
| **2. Your PC + Cloudflare tunnel** | free | only while your PC is on | no, changes every start | 5 minutes |
| **3. Your own server (Nebius or any Linux server)** | server price | yes | yes | about 1 hour |

Local development is separate: frontend `http://localhost:5173`, backend `http://localhost:8080` (see the main README).

---

## 1. Render + Neon (free)

```
browser ──https──▶ Render (free web service: website + API, in one Docker image)
                      ├──▶ Neon (free Postgres: accounts, workouts, encrypted photos)
                      ├──▶ Nebius Token Factory (the AI models)
                      └──▶ Brevo (free email service, sends the sign-up codes)
```

Why these parts:
- **Neon** keeps your data. Render's own free disk is erased on every restart and sleep, and its free database is deleted after 30 days, so the app refuses to start on Render without a `DATABASE_URL` rather than silently lose accounts.
- **Brevo** sends the sign-up emails over a web API, because **Render's free tier blocks the ports used for SMTP email (25, 465, 587)**, so Gmail SMTP cannot work there. Brevo's free plan allows 300 emails a day. If Brevo will not work for you, `mail-relay.gs` (a free Google Apps Script that sends from your own Gmail) is the fallback.

### Step 1: The database (Neon, about 3 minutes)
1. Sign up at **neon.com** (GitHub or Google login).
2. **Create project**: any name, Postgres 16 or newer, a region near the Render region you will use.
3. On the project dashboard click **Connect**, tick **Connection pooling**, and copy the connection string. It looks like `postgresql://user:password@ep-something-pooler.region.aws.neon.tech/neondb?sslmode=require`. Keep it secret: it is your `DATABASE_URL`.

Neon's free plan (their docs): 1 GB storage, 100 compute-hours a month, and the database itself sleeps after 5 minutes of inactivity and wakes by itself on the next request.

### Step 2: Email (Brevo, about 10 minutes)
1. Sign up at **brevo.com** (free plan) and finish the account questions. A new account may be checked before it can send; if so, wait for the approval email.
2. Add a sender: open the account menu, **Senders, Domains & Dedicated IPs**, **Senders**, **Add a sender**. Use your Gmail address as the email and `RepSight` as the name. Brevo emails you a code to verify it.
3. Make an API key: account menu, **SMTP & API**, **API Keys**, **Generate a new API key**. Copy it now (it starts with `xkeysib-` and is shown once).
4. These become `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` (the verified sender). Test them from your PC before using Render:
   ```powershell
   $env:BREVO_API_KEY = "<the key>"; $env:BREVO_SENDER_EMAIL = "<the verified sender>"
   python backend/send_test_email.py yourotheraddress@gmail.com
   ```
   It says "Sent" and the email arrives (check spam). If Brevo refuses the sender, the message says so: a Gmail sender may not be accepted. Then use the fallback, `mail-relay.gs`: the instructions are at the top of that file, and its two values go in `MAIL_WEBHOOK_URL` and `MAIL_WEBHOOK_SECRET`.

I have not used Brevo's current screens or confirmed that it accepts a Gmail address as the sender; the steps above come from its API documentation, so menu names may differ slightly.

### Step 3: Put the code on GitHub
Render builds from your GitHub repo, so the latest work must be pushed (including `render.yaml` and the `deploy` folder).

### Step 4: Render (about 5 minutes)
1. Sign up at **render.com** with GitHub.
2. **New, then Blueprint**, choose the `Fitness-coach` repo. Render reads `render.yaml`.
3. It asks for the secret values once. Fill in:
   - `DATABASE_URL`: the Neon string from step 1
   - `NEBIUS_API_KEY`: your Token Factory key
   - `BREVO_API_KEY` and `BREVO_SENDER_EMAIL`: from step 2
   - `MAIL_WEBHOOK_URL` and `MAIL_WEBHOOK_SECRET`: leave empty unless you use the Google script instead
4. Click **Apply**. The first build takes a few minutes. When it says **Live**, open the address Render shows (`https://repsight.onrender.com` or similar).

### Step 5: Test it like a user
- Create an account with a real email: the code must arrive by email.
- Log a set, upload a photo (the page shrinks it first), ask the coach a question, use Kinetiq with the camera.
- Come back after 20 minutes: the first load is slow (the service woke up), and you are still logged in with your data.

### What to expect
- **Sleeping.** After 15 minutes without visitors the service sleeps and the next visit takes about a minute. A free pinger such as UptimeRobot visiting `/api/meta/countries` every 5 minutes keeps it awake; Render grants 750 free hours a month, enough for one always-awake service. (Not tested here.)
- **Photos are shrunk to about 1600 pixels** in the browser and capped at 6 MB, to stay inside Neon's 1 GB.
- **Logins survive sleep** (`LOGOUT_ON_START=0`). Locally, a restart still logs everyone out.
- **Backups.** Neon keeps short history on the free plan; do not treat it as a backup. The photos are encrypted with each user's password, so a backup is useless without it.

---

## 2. Your PC + a Cloudflare tunnel (free, for demos)

Your PC runs the backend, which also serves the website, and a free **Cloudflare tunnel** gives it a public `https://` address. No account, server or card.

One-time:
1. `winget install --id Cloudflare.cloudflared`, then open a **new** PowerShell.
2. In `.env`, fill `SMTP_USER` and `SMTP_PASSWORD` (a Gmail App password). Public mode refuses to start without working email.

Each time:
```powershell
cd C:\Files\Fitness-coach-main
powershell -File deploy\run-public.ps1
```
It builds the site if needed, starts the backend, and prints an address like `https://random-words.trycloudflare.com`. Ctrl+C stops everything.

Limits: the address changes every start; it works only while your PC is on and online; Cloudflare calls quick tunnels testing-grade with no uptime promise; your own local database is what is served.

---

## 3. Your own server (Nebius or any Linux server)

The Docker kit in this folder runs the app plus Caddy (free HTTPS) on one server, with the database in SQLite on the server's disk.

1. Create a small Ubuntu server with a public IP, open ports 22, 80 and 443, and point a DNS name at it (a free DuckDNS name works).
2. Install Docker: `curl -fsSL https://get.docker.com | sudo sh`, then `sudo usermod -aG docker $USER` and log in again.
3. From your PC, send the project:
   ```powershell
   tar --exclude=backend/app.db --exclude=__pycache__ -czf repsight.tgz backend deploy frontend-ts requirements.txt .dockerignore
   scp -i $HOME\.ssh\<key> repsight.tgz ubuntu@<IP>:~
   ```
   On the server: `mkdir -p ~/repsight && tar -xzf ~/repsight.tgz -C ~/repsight && cd ~/repsight`
4. `cp deploy/.env.production.example deploy/.env.production`, edit it (`nano`), then check it with `python3 deploy/preflight.py`.
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build`
6. Open `https://<your-name>/api/meta/countries`.

SMTP works here, so Gmail with an app password is fine (or use the relay). Add `DATABASE_URL` to use Neon instead of the server's disk.

---

## Settings reference

| Setting | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres address (Neon). Empty = a local SQLite file. |
| `APP_ENV=production` | Refuses to start without working email. |
| `TRUST_PROXY` | `cloudflare` (Render, tunnel) or `1` (your own proxy): where to read the real visitor address from. Empty when nothing is in front. |
| `FORCE_SECURE_COOKIES=1` | Login cookie only travels over https. |
| `LOGOUT_ON_START` | `1` (default): a restart logs everyone out. `0` on hosts that sleep and wake. |
| `MAX_IMAGE_MB` | Photo size cap (6 on Postgres, 10 on SQLite by default). |
| `ALLOWED_ORIGINS` | Only if the website is on a different address from the API. Empty when they share one. |
| `BREVO_API_KEY` / `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME` | Brevo's web API (works on Render's free tier). Tried first. |
| `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_SECRET` | The Google Apps Script web relay (fallback for Render's free tier). |
| `SMTP_*` | Direct email over SMTP (your PC or your own server). |

## Checker

`python deploy/preflight.py [env-file]` lists anything missing in an env file (it never prints secrets). `python backend/send_test_email.py you@gmail.com` sends one test email with whichever method is configured.

## What has been tested, and what has not

Tested (local machine, 2026-10-26):
- The full test suite passes on both SQLite and a real PostgreSQL 16 (Docker).
- The Docker image (website build included) builds, and runs as an ordinary user on Render's port with the Render settings: refuses to start without `DATABASE_URL`, creates its tables in Postgres, stores photos encrypted in the database, keeps logins and data across a stop and start, limits wrong logins per visitor address, and caps photo size.
- The Brevo code against a fake Brevo server (key and sender sent correctly, a wrong key and an unverified sender give a clear reason, the key is never shown), and the Google relay code against a fake that behaves like Apps Script, including its redirect.

Not tested: Render itself, Neon itself (Postgres 16 in Docker stands in), the real Brevo and Apps Script services, real emails, UptimeRobot, a real domain. The first real deploy is the real test, so follow step 5 above.

## Known limits

- Free tiers change; the Render, Neon and Cloudflare limits above come from their own documentation and may differ when you read this.
- Rate limits are per process and reset on restart (Render free runs one process).
- Demo scale: no failover, and Neon's free history is not a backup plan.
