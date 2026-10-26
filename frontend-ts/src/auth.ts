import { api } from './api';
import type { Country } from './api';
import { $, esc, messageOf } from './ui';

type Mode = 'login' | 'signup' | 'code';

const TEMPLATE = `
  <form class="card auth-card" id="auth-form" autocomplete="on" novalidate>
    <div class="brand">Rep<span>Sight</span></div>
    <h2 id="auth-title">Log in</h2>
    <p class="mut" id="auth-sub"></p>
    <label class="field-inline" id="row-email"><span>Email</span><input id="auth-email" name="email" type="email" autocomplete="email" maxlength="254" required></label>
    <button class="link did-you-mean" id="auth-fix" type="button" hidden></button>
    <label class="field-inline" id="row-pass"><span>Password</span><input id="auth-pass" name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
    <label class="field-inline" id="row-confirm"><span>Confirm password</span><input id="auth-confirm" name="confirm" type="password" autocomplete="new-password" maxlength="128" required></label>
    <label class="field-inline" id="row-age"><span>Age</span><input id="auth-age" name="age" type="number" inputmode="numeric" min="13" max="120" step="1" autocomplete="off" required></label>
    <div class="field-inline" id="row-phone">
      <span>Phone number</span>
      <div class="phone-row">
        <select id="auth-cc" name="country" aria-label="Country code"></select>
        <input id="auth-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="24" placeholder="98765 43210" aria-label="Phone number without the country code" required>
      </div>
    </div>
    <label class="field-inline" id="row-code"><span>6-digit code</span><input id="auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6"></label>
    <p class="err" id="auth-err" role="alert"></p>
    <button class="btn-primary" id="auth-go" type="submit">Log in</button>
    <button class="link" id="auth-switch" type="button"></button>
    <button class="link" id="auth-resend" type="button" hidden>Send a new code</button>
    <p class="mut small" id="auth-note" hidden>All fields are required. The password needs at least 8 characters that are not spaces. Photos and chat history are encrypted with a key tied to your password, so a forgotten password cannot be recovered. Your phone number is stored encrypted and is never sent to the AI.</p>
  </form>
`;

/** Same pattern the server uses: 3-254 characters, local part up to 64 with no leading, trailing or doubled dots, valid domain labels, 2-24 letter top-level domain. */
const EMAIL = /^(?=.{3,254}$)(?=[^@]{1,64}@)(?!.*\.\.)[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/;
/** Placeholder domains that can never receive mail (RFC 2606 / 6761). Same list as the server. */
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu'];
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost', 'local', 'localdomain', 'internal'];
function isReservedDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).replace(/\.$/, '');
  return RESERVED_TLDS.includes(domain.split('.').pop() ?? '') || RESERVED_DOMAINS.some((r) => domain === r || domain.endsWith(`.${r}`));
}
const RESERVED_MESSAGE = (email: string): string => `${email.slice(email.lastIndexOf('@') + 1)} is only a placeholder domain and cannot receive email. Use your own email address`;

/** Spaces never count toward the 8 characters, so a password of spaces is refused. */
const realChars = (text: string): number => text.replace(/\s/g, '').length;

/** Mirrors the server's phone rules: digits only, no country code (that is the dropdown), one leading 0 dropped, length per country. */
function normalizePhone(country: Country, raw: string): { phone?: string; problem?: string } {
  const text = raw.trim();
  if (text.startsWith('+') || !/^[0-9 ().\- ]*$/.test(text)) return { problem: 'Type the number without the country code, using digits only' };
  let digits = text.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.startsWith(country.dial) && digits.length > country.max) digits = digits.slice(country.dial.length);
  if (digits.length < country.min || digits.length > country.max) {
    const want = country.min === country.max ? `${country.min}` : `${country.min} to ${country.max}`;
    return { problem: `Phone numbers in ${country.name} have ${want} digits (without the +${country.dial} country code)` };
  }
  return { phone: `+${country.dial}${digits}` };
}

/** Keystroke distance (an insert, delete, change or swap of two neighbours counts 1). Same rule as the server. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** If the email's domain looks like a typo of a popular one (gmsil.com), returns the corrected address, else null. */
function suggestEmail(email: string, domains: { popular: string[]; known: string[] }): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1);
  if (!domain || domains.known.includes(domain)) return null;
  const limit = domain.length < 12 ? 1 : 2;
  let best = '';
  let bestDistance = Infinity;
  for (const p of domains.popular) {
    const dist = editDistance(domain, p);
    if (dist < bestDistance) [best, bestDistance] = [p, dist];
  }
  return bestDistance <= limit ? `${email.slice(0, at)}@${best}` : null;
}

/** Picks the dropdown's starting country from the browser's language or time zone. */
function guessCountry(list: Country[]): string {
  let region = '';
  try {
    region = new Intl.Locale(navigator.language).region ?? '';
  } catch {
    /* old browser: fall through */
  }
  if (!region) region = /Kolkata|Calcutta/.test(Intl.DateTimeFormat().resolvedOptions().timeZone) ? 'IN' : '';
  if (list.some((c) => c.code === region)) return region;
  return list.some((c) => c.code === 'US') ? 'US' : (list[0]?.code ?? '');
}

/** Resolves with the signed-in email once the user is logged in (immediately if a session already exists). */
export async function requireLogin(): Promise<string> {
  try {
    return (await api.me()).username;
  } catch {
    /* not signed in: show the form below */
  }
  const box = $('auth');
  box.innerHTML = TEMPLATE;
  box.hidden = false;

  let mode: Mode = 'login';
  let timer = 0;
  let countries: Country[] = [];
  let domains: { popular: string[]; known: string[] } = { popular: [], known: [] };
  const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
  const show = (id: string, on: boolean): void => {
    $(id).hidden = !on;
  };
  const err = (text: string, field?: string): void => {
    $('auth-err').textContent = text;
    if (field) $(field).focus();
  };
  const country = (): Country | undefined => countries.find((c) => c.code === $<HTMLSelectElement>('auth-cc').value);

  api
    .countries()
    .then((list) => {
      countries = list;
      $('auth-cc').innerHTML = list.map((c) => `<option value="${esc(c.code)}">${esc(c.name)} (+${esc(c.dial)})</option>`).join('');
      $<HTMLSelectElement>('auth-cc').value = guessCountry(list);
    })
    .catch(() => err('Could not load the country list. Is the backend running?'));

  api.emailDomains().then((d) => (domains = d)).catch(() => undefined); // if this fails the server still catches the typo

  /** Shows "Did you mean ...?" with a one-click fix. Returns true when the address looks mistyped. */
  function flagTypo(): boolean {
    const fix = suggestEmail(values().email, domains);
    const button = $<HTMLButtonElement>('auth-fix');
    button.hidden = !fix;
    if (fix) {
      button.textContent = `Did you mean ${fix}? Click to use it`;
      button.dataset.fix = fix;
      err('That email address looks misspelled');
    }
    return !!fix;
  }
  $('auth-fix').addEventListener('click', () => {
    input('auth-email').value = $('auth-fix').dataset.fix ?? input('auth-email').value;
    $('auth-fix').hidden = true;
    err('');
  });

  const values = () => ({
    email: input('auth-email').value.trim().toLowerCase(),
    password: input('auth-pass').value,
    confirm: input('auth-confirm').value,
    age: input('auth-age').value,
    phone: input('auth-phone').value,
  });

  /** Returns the first problem with the sign-up form, or the finished request body. */
  function signupBody(): { body?: Parameters<typeof api.signupStart>[0]; problem?: { field: string; message: string } } {
    const v = values();
    if (!EMAIL.test(v.email)) return { problem: { field: 'auth-email', message: 'Enter a valid email address, like name@gmail.com' } };
    if (isReservedDomain(v.email)) return { problem: { field: 'auth-email', message: RESERVED_MESSAGE(v.email) } };
    if (flagTypo()) return { problem: { field: 'auth-email', message: 'That email address looks misspelled' } };
    if (realChars(v.password) < 8) return { problem: { field: 'auth-pass', message: 'Password needs at least 8 characters that are not spaces' } };
    if (v.password !== v.confirm) return { problem: { field: 'auth-confirm', message: 'The two passwords do not match' } };
    if (!/^[0-9]{1,3}$/.test(v.age.trim()) || Number(v.age) < 13 || Number(v.age) > 120) return { problem: { field: 'auth-age', message: 'Enter your age as a whole number from 13 to 120' } };
    const c = country();
    if (!c) return { problem: { field: 'auth-cc', message: 'Choose a country code' } };
    const phone = normalizePhone(c, v.phone);
    if (!phone.phone) return { problem: { field: 'auth-phone', message: phone.problem ?? 'Enter a valid phone number' } };
    return { body: { email: v.email, password: v.password, confirm_password: v.confirm, age: Number(v.age), phone_country: c.code, phone: v.phone } };
  }

  function render(next: Mode, message = ''): void {
    mode = next;
    window.clearInterval(timer);
    $('auth-title').textContent = { login: 'Log in', signup: 'Create your account', code: 'Check your email' }[next];
    $('auth-sub').textContent = {
      login: 'Your workouts, photos and chats are private to your account.',
      signup: 'We check your email domain, then email you a 6-digit code to confirm the address is yours.',
      code: message,
    }[next];
    show('row-email', next !== 'code');
    show('row-pass', next !== 'code');
    show('row-confirm', next === 'signup');
    show('row-age', next === 'signup');
    show('row-phone', next === 'signup');
    show('row-code', next === 'code');
    show('auth-resend', next === 'code');
    show('auth-note', next === 'signup');
    $('auth-go').textContent = { login: 'Log in', signup: 'Send me a code', code: 'Verify and continue' }[next];
    $('auth-switch').textContent = { login: 'New here? Create an account', signup: 'Already have an account? Log in', code: 'Back' }[next];
    input('auth-pass').autocomplete = next === 'signup' ? 'new-password' : 'current-password';
    err('');
    if (next === 'code') {
      input('auth-code').value = '';
      input('auth-code').focus();
      cooldown(30);
    }
  }

  function cooldown(seconds: number): void {
    const resend = $<HTMLButtonElement>('auth-resend');
    let left = seconds;
    resend.disabled = true;
    const tick = (): void => {
      resend.textContent = left > 0 ? `Send a new code in ${left}s` : 'Send a new code';
      resend.disabled = left > 0;
      if (left-- <= 0) window.clearInterval(timer);
    };
    tick();
    timer = window.setInterval(tick, 1000);
  }

  const sentMessage = (dev: boolean): string =>
    dev
      ? 'Email sending is not set up on this server yet, so the code was printed in the backend terminal. Enter it below.'
      : `We sent a 6-digit code to ${values().email}. It expires in 10 minutes.`;

  // Phone box: digits only, never more than this country allows, and a space after the 5th digit as they type or paste (98765 43210).
  // (The box's own maxlength is generous on purpose: a browser cuts pasted text to it BEFORE this code can strip a +91 or a 0.)
  const phoneBox = input('auth-phone');
  phoneBox.addEventListener('input', () => {
    const c = country();
    const max = c?.max ?? 14;
    let digits = phoneBox.value.replace(/\D/g, '');
    if (c && digits.length > max && digits.startsWith(c.dial)) digits = digits.slice(c.dial.length); // pasted with the country code
    if (digits.length > max && digits.startsWith('0')) digits = digits.slice(1); // pasted with the leading 0
    digits = digits.slice(0, max);
    const before = phoneBox.value.slice(0, phoneBox.selectionStart ?? phoneBox.value.length).replace(/\D/g, '').length;
    phoneBox.value = digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
    const caret = Math.min(before, digits.length);
    const at = caret > 5 ? caret + 1 : caret; // the space sits after the 5th digit
    phoneBox.setSelectionRange(at, at);
  });
  $('auth-cc').addEventListener('change', () => phoneBox.dispatchEvent(new Event('input')));

  // Tell the user about a bad email as soon as they leave the field, not only on submit.
  input('auth-email').addEventListener('blur', () => {
    if (mode !== 'signup' || !values().email) return;
    if (!EMAIL.test(values().email)) err('Enter a valid email address, like name@gmail.com');
    else if (isReservedDomain(values().email)) err(RESERVED_MESSAGE(values().email));
    else flagTypo();
  });
  input('auth-email').addEventListener('input', () => {
    $('auth-fix').hidden = true;
    if (mode === 'signup' && EMAIL.test(values().email)) err('');
  });

  $('auth-switch').addEventListener('click', () => render(mode === 'login' ? 'signup' : mode === 'signup' ? 'login' : 'signup'));
  $('auth-resend').addEventListener('click', () => {
    err('');
    const built = signupBody();
    if (!built.body) return err(built.problem?.message ?? '');
    api
      .signupStart(built.body)
      .then((r) => {
        $('auth-sub').textContent = sentMessage(r.dev);
        cooldown(30);
      })
      .catch((error) => err(messageOf(error)));
  });

  return new Promise((resolve) => {
    $('auth-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      err('');
      const v = values();
      let built: ReturnType<typeof signupBody> = {};
      if (mode === 'login') {
        if (!EMAIL.test(v.email) && v.email.length < 3) return err('Enter your email', 'auth-email');
        if (v.password.length === 0) return err('Enter your password', 'auth-pass');
      } else if (mode === 'signup') {
        built = signupBody();
        if (!built.body) return err(built.problem?.message ?? '', built.problem?.field);
      } else if (!/^[0-9]{6}$/.test(input('auth-code').value.trim())) {
        return err('Enter the 6-digit code from the email', 'auth-code');
      }
      const button = $<HTMLButtonElement>('auth-go');
      button.disabled = true;
      let job: Promise<{ username: string } | void>;
      if (mode === 'login') job = api.login(v.email, v.password);
      else if (mode === 'signup' && built.body) job = api.signupStart(built.body).then((r) => render('code', sentMessage(r.dev)));
      else job = api.signupVerify(v.email, input('auth-code').value.trim(), v.password); // the password is only ever held here in the page, never kept by the server
      job
        .then((who) => {
          if (!who) return;
          window.clearInterval(timer);
          box.hidden = true;
          box.innerHTML = '';
          resolve(who.username);
        })
        .catch((error) => err(messageOf(error)))
        .finally(() => {
          button.disabled = false;
        });
    });
    render('login');
  });
}
