"""Run this before going public. It checks the deployment files for placeholders and missing values, and never prints a secret.

    python deploy/preflight.py                 # checks deploy/.env.production
    python deploy/preflight.py path/to/env     # check a different env file
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "deploy" / ".env.production"
problems: list[str] = []
ok: list[str] = []


def check(condition: bool, good: str, bad: str) -> None:
    (ok if condition else problems).append(good if condition else bad)


# ---- server settings ----
if not env_path.exists():
    problems.append(f"{env_path} does not exist: copy deploy/.env.production.example to it and fill it in")
else:
    values = {}
    for line in env_path.read_text(encoding="utf8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    check(bool(values.get("NEBIUS_API_KEY")), "NEBIUS_API_KEY is set", "NEBIUS_API_KEY is empty")
    smtp = all(values.get(k) for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"))
    relay = all(values.get(k) for k in ("MAIL_WEBHOOK_URL", "MAIL_WEBHOOK_SECRET"))
    check(smtp or relay, "email is set up (" + ("web relay" if relay else "SMTP") + ")",
          "no email set up: fill SMTP_HOST, SMTP_USER and SMTP_PASSWORD, or MAIL_WEBHOOK_URL and MAIL_WEBHOOK_SECRET (Render's free tier blocks SMTP: use the relay)")
    if relay:
        check(values["MAIL_WEBHOOK_URL"].startswith("https://") and len(values["MAIL_WEBHOOK_SECRET"]) >= 20, "web relay URL is https and its secret is long enough",
              "MAIL_WEBHOOK_URL must start with https:// and MAIL_WEBHOOK_SECRET needs at least 20 characters")
    if values.get("DATABASE_URL"):
        check(values["DATABASE_URL"].startswith(("postgresql://", "postgres://")) and "sslmode=require" in values["DATABASE_URL"],
              "DATABASE_URL is a Postgres address with sslmode=require", "DATABASE_URL must start with postgresql:// and end with ?sslmode=require (copy it from the Neon dashboard)")
    else:
        check(values.get("API_DOMAIN", "") not in ("", "api.yourdomain.com") and "://" not in values.get("API_DOMAIN", ""),
              "API_DOMAIN looks real (own-server setup, data in SQLite on the server's disk)", "API_DOMAIN is still the example, or has https:// in front (it must be just the name)")
    origins = [o for o in values.get("ALLOWED_ORIGINS", "").split(",") if o]
    if origins:
        check(all(o.startswith("https://") and not o.endswith("/") for o in origins) and "yourproject" not in values.get("ALLOWED_ORIGINS", ""),
              "ALLOWED_ORIGINS are https addresses without a trailing slash", "ALLOWED_ORIGINS must be your real https web address(es), no trailing slash")
    else:
        ok.append("ALLOWED_ORIGINS is empty: fine when the website and the API share one address (leave it empty then)")
    for key, want in (("APP_ENV", "production"), ("TRUST_PROXY", "1"), ("FORCE_SECURE_COOKIES", "1")):
        check(values.get(key) == want, f"{key}={want}", f"{key} must be {want}")
    check(not re.search(r"^NEBIUS_API_KEY=your", env_path.read_text(encoding="utf8"), re.M), "NEBIUS_API_KEY is not a placeholder", "NEBIUS_API_KEY looks like a placeholder")

for line in ok:
    print("  ok    ", line)
for line in problems:
    print("  FIX   ", line)
print("\nReady to deploy." if not problems else f"\n{len(problems)} thing(s) to fix before going public.")
sys.exit(1 if problems else 0)
