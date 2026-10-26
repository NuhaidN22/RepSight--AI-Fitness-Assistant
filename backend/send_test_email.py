"""Checks that RepSight can really send email, using the SMTP_* settings in .env.

    python backend/send_test_email.py you@gmail.com

It sends one test message and tells you in plain words what to fix if it fails. Nothing is stored."""
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
sys.path.insert(0, os.path.dirname(__file__))
import mailer  # noqa: E402

if len(sys.argv) != 2 or "@" not in sys.argv[1]:
    sys.exit("Usage: python backend/send_test_email.py you@gmail.com")

print("Mail setup:", mailer.describe())
if not mailer.configured():
    sys.exit("\nSMTP_HOST, SMTP_USER and SMTP_PASSWORD are not all set in .env, so nothing can be sent yet.")
try:
    mailer.send(sys.argv[1], "RepSight test email", "If you can read this, RepSight can send sign-up codes. Test code: 123456")
except Exception as error:  # noqa: BLE001 - we want to explain any failure
    sys.exit(f"\nSending failed.\n  {mailer.explain(error)}")
print(f"\nSent. Check the inbox of {sys.argv[1]} (and the spam folder).")
