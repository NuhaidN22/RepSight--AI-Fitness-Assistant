"""Sends the sign-up code by email. Three ways, tried in this order:
  0. Brevo's web API (BREVO_API_KEY + BREVO_SENDER_EMAIL): an HTTPS call, works on hosts that block SMTP ports (Render's free tier);
  1. a web relay (MAIL_WEBHOOK_URL + MAIL_WEBHOOK_SECRET): an HTTPS call, for hosts such as Render's free tier that block SMTP ports;
     deploy/mail-relay.gs is a ready-made free relay (Google Apps Script) that sends from your own Gmail;
  2. SMTP (for example Gmail with an app password).

If SMTP is not configured, nothing is sent: the message is printed in the backend terminal and kept in OUTBOX.
That is only meant for local development and for the tests."""
import json
import logging
import os
import smtplib
import socket
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlparse
from email.message import EmailMessage

log = logging.getLogger("repsight")
OUTBOX: list[dict] = []


class MailError(Exception):
    """The mail service answered but refused to send. provider says which one, so the explanation can name the right setting."""
    def __init__(self, message, provider="webhook"):
        super().__init__(message)
        self.provider = provider


BREVO_URL = "https://api.brevo.com/v3/smtp/email"


def brevo_configured() -> bool:
    return bool(os.getenv("BREVO_API_KEY") and os.getenv("BREVO_SENDER_EMAIL"))


def webhook_configured() -> bool:
    return bool(os.getenv("MAIL_WEBHOOK_URL") and os.getenv("MAIL_WEBHOOK_SECRET"))


def smtp_configured() -> bool:
    return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))


def configured() -> bool:
    return brevo_configured() or webhook_configured() or smtp_configured()


def describe() -> str:
    """One line for the startup banner. Never includes the password."""
    if not configured():
        return "DEV MODE: email is not set up, so sign-up codes are printed here instead of emailed (see SMTP_* or MAIL_WEBHOOK_* in .env)"
    if brevo_configured():
        return f"emailing codes through Brevo as {os.getenv('BREVO_SENDER_EMAIL')}"
    if webhook_configured():
        return f"emailing codes through the web relay at {urlparse(os.getenv('MAIL_WEBHOOK_URL')).netloc}"
    return f"emailing codes through {os.getenv('SMTP_HOST')}:{os.getenv('SMTP_PORT', '587')} as {os.getenv('SMTP_USER')}"


def explain(error: Exception) -> str:
    """A plain-language reason and fix for an SMTP failure (used in the log and by send_test_email.py)."""
    host = os.getenv("SMTP_HOST", "?")
    port = os.getenv("SMTP_PORT", "587")
    if isinstance(error, MailError) and error.provider == "brevo" and "unrecognised ip" in str(error).lower():
        return ("Brevo blocked this computer's IP address (its API security feature). Your key is fine. In Brevo: account menu, Security, Authorised IPs: "
                "authorise this IP, or switch the blocking off (needed on Render, whose address is not fixed). Brevo also emails you a link to approve it.")
    if isinstance(error, MailError) and error.provider == "brevo":
        return (f"Brevo refused to send: {error}. Check that BREVO_API_KEY is a v3 API key (starts with xkeysib-), and that BREVO_SENDER_EMAIL is a sender "
                "you added and verified under Senders, Domains & Dedicated IPs in Brevo. A new Brevo account may also need to be approved first.")
    if isinstance(error, MailError):
        return f"The web relay refused to send: {error}. Check MAIL_WEBHOOK_SECRET matches the SECRET in the script, and that the script is deployed for 'Anyone'."
    if isinstance(error, urllib.error.HTTPError):
        return f"The mail service answered with HTTP {error.code}. If you use the Google script, MAIL_WEBHOOK_URL must be the web app URL ending in /exec."
    if isinstance(error, urllib.error.URLError):
        return f"Could not reach the mail service ({error.reason}). Check your internet connection, and BREVO_API_URL / MAIL_WEBHOOK_URL if you set one."
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return ("The mail server refused the login. For Gmail: turn on 2-step verification, create an App password "
                "(Google Account > Security > App passwords) and use that 16-letter password as SMTP_PASSWORD, not your normal one.")
    if isinstance(error, smtplib.SMTPRecipientsRefused):
        return "The mail server refused the recipient address."
    if isinstance(error, (smtplib.SMTPConnectError, socket.timeout, TimeoutError, ConnectionError, socket.gaierror)):
        return f"Could not reach {host}:{port}. Check SMTP_HOST and SMTP_PORT (587 for STARTTLS, 465 for SSL) and your internet or firewall."
    if isinstance(error, ssl.SSLError):
        return f"The secure connection to {host}:{port} failed. Port 587 uses STARTTLS and port 465 uses SSL; make sure SMTP_PORT matches."
    if isinstance(error, smtplib.SMTPSenderRefused):
        return "The mail server refused the From address. SMTP_FROM should be the same address as SMTP_USER (or one it is allowed to send as)."
    return f"{type(error).__name__}: {error}"


def _connect(host: str, port: int) -> smtplib.SMTP:
    context = ssl.create_default_context()
    if port == 465:  # implicit SSL, the older Gmail option
        return smtplib.SMTP_SSL(host, port, timeout=15, context=context)
    server = smtplib.SMTP(host, port, timeout=15)
    server.starttls(context=context)
    return server


def _send_brevo(to: str, subject: str, body: str, html: str | None) -> None:
    url = os.getenv("BREVO_API_URL", BREVO_URL)   # BREVO_API_URL exists only so tests can point at a fake server
    parts = urlparse(url)
    if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")):
        raise MailError("BREVO_API_URL must start with https://", provider="brevo")   # the API key travels in the request
    payload = {"sender": {"name": os.getenv("BREVO_SENDER_NAME", "RepSight"), "email": os.environ["BREVO_SENDER_EMAIL"]}, "to": [{"email": to}],
               "subject": subject, "textContent": body}
    if html:
        payload["htmlContent"] = html
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "api-key": os.environ["BREVO_API_KEY"]})
    try:
        with urllib.request.urlopen(request, timeout=20):
            return   # 201 Created: Brevo accepted the message
    except urllib.error.HTTPError as error:
        try:
            reason = json.loads(error.read().decode("utf8") or "{}").get("message") or ""
        except Exception:  # noqa: BLE001 - an unreadable error body is fine, we still know the status code
            reason = ""
        raise MailError(f"HTTP {error.code}" + (f": {reason[:300]}" if reason else ""), provider="brevo") from None   # never echo the request: it holds the key


def _send_webhook(to: str, subject: str, body: str, html: str | None) -> None:
    url = os.environ["MAIL_WEBHOOK_URL"]
    parts = urlparse(url)
    if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")):
        raise MailError("MAIL_WEBHOOK_URL must start with https://")   # the secret travels in the request, so never over plain http
    payload = json.dumps({"secret": os.environ["MAIL_WEBHOOK_SECRET"], "to": to, "subject": subject, "body": body, "html": html}).encode()
    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:   # Apps Script answers with a 302 that urllib follows
        answer = json.loads(response.read().decode("utf8") or "{}")
    if not answer.get("ok"):
        raise MailError(str(answer.get("error") or "no reason given")[:120])


def send(to: str, subject: str, body: str, html: str | None = None) -> None:
    if any(ch in value for value in (to, subject) for ch in "\r\n"):
        raise ValueError("line break in an email header")  # header injection guard; the address is also validated earlier
    if not configured():
        OUTBOX.append({"to": to, "subject": subject, "body": body})
        del OUTBOX[:-50]
        print(f"\n[mail] SMTP is not configured, so this email was NOT sent. Local-dev copy:\n  To: {to}\n  Subject: {subject}\n  {body}\n")
        return
    if brevo_configured():
        _send_brevo(to, subject, body, html)
        return
    if webhook_configured():
        _send_webhook(to, subject, body, html)
        return
    msg = EmailMessage()
    msg["From"] = os.getenv("SMTP_FROM") or os.environ["SMTP_USER"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    with _connect(os.environ["SMTP_HOST"], int(os.getenv("SMTP_PORT", "587"))) as server:
        server.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        server.send_message(msg)
