/**
 * RepSight mail relay: a free way to send sign-up codes from your own Gmail over HTTPS.
 * Needed on hosts that block SMTP ports (Render's free tier does).
 *
 * Setup (about 3 minutes):
 *  1. Go to script.google.com, click "New project", delete the sample code and paste this whole file in.
 *  2. Left menu, Project Settings (gear), "Script properties", Add property: name SECRET, value = a long random
 *     password you make up (30+ characters). Save. Use the same text as MAIL_WEBHOOK_SECRET in RepSight's settings.
 *  3. Top right, "Deploy", "New deployment", gear icon, "Web app":
 *       Execute as: Me          Who has access: Anyone
 *     Click Deploy, then "Authorize access" and allow sending email. (Google shows an "unverified app" warning for
 *     your own script: Advanced, "Go to ... (unsafe)" is correct, because it is your own code.)
 *  4. Copy the "Web app URL" (it ends in /exec). That is MAIL_WEBHOOK_URL in RepSight's settings.
 *
 * Emails are sent from the Gmail account that deployed it. A normal Gmail account can send about 100 emails a day this way.
 * Anyone who knows the URL AND the secret can send mail as you, so keep both private. To switch it off, delete the deployment.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || secret.length < 20) return reply({ ok: false, error: 'set a SECRET script property of at least 20 characters' });
    if (data.secret !== secret) return reply({ ok: false, error: 'wrong secret' });
    if (typeof data.to !== 'string' || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(data.to)) return reply({ ok: false, error: 'bad address' });
    var options = { name: 'RepSight' };
    if (data.html) options.htmlBody = String(data.html);
    MailApp.sendEmail(data.to, String(data.subject || 'RepSight').slice(0, 200), String(data.body || ''), options);
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err).slice(0, 120) });
  }
}

// Opening the web app URL in a browser shows this: a quick way to check the deployment is live. It sends nothing and reveals nothing.
function doGet() {
  return reply({ ok: true, service: 'RepSight mail relay', note: 'alive; RepSight POSTs messages to this address' });
}

function reply(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}
