import { api } from './api';
import type { FormResult } from './api';
import { createCounter, EXERCISES, toFormRep } from './repCounter';
import type { Counter, Rep } from './repCounter';
import { $, messageOf } from './ui';

/* ---------- Minimal MediaPipe typings (library is loaded from the CDN on first use) ---------- */
interface Pt {
  x: number;
  y: number;
}
interface Landmark extends Pt {
  z?: number;
  visibility?: number;
}
interface PoseDetector {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks: Landmark[][]; worldLandmarks?: Landmark[][] };
}
interface MediaPipeModule {
  FilesetResolver: { forVisionTasks(wasmPath: string): Promise<unknown> };
  PoseLandmarker: { createFromOptions(fileset: unknown, options: object): Promise<PoseDetector> };
}

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
// Same BlazePose family in three sizes: bigger = more accurate with hidden or odd-angle joints, but slower.
type ModelSize = 'full' | 'heavy';
const modelUrl = (size: ModelSize): string =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${size}/float16/1/pose_landmarker_${size}.task`;

const MIN_VISIBILITY = 0.5; // shoulders and hips must each be at least this visible
const SIDE_OK = 0.35; // shoulder-width / torso-length below this = clean side view
const SIDE_MAX = 0.55; // above this = facing the camera, so lean and elbow drift cannot be judged
const MAX_PEOPLE = 4; // pose model looks for up to this many people, then we follow just one
const FOLLOW_DIST = 0.3; // target may move at most this far (fraction of frame height) between frames
const GRACE_FRAMES = 8; // tolerate ~0.25 s of tracking flicker before showing a hint

type Stage = 'idle' | 'loading' | 'live' | 'analyzing' | 'done';
type Check = 'idle' | 'ok' | 'warn' | 'bad';
/** An error whose message is already written for the user. */
class UserFacingError extends Error {}

const PHASE_LABEL: Record<Stage, string> = {
  idle: 'Waiting',
  loading: 'Loading',
  live: 'Tracking',
  analyzing: 'Analyzing',
  done: 'Done',
};

const CHECK_DEFAULTS: Record<string, string> = {
  'chk-body': 'Body in frame',
  'chk-side': 'Side view',
  'chk-move': 'Movement',
};

/* ---------- Icons (inline SVG so they look the same on every OS) ---------- */
const icon = (paths: string): string =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const I_SIDE = icon('<path d="M4 20V4l16 16z"/>');
const I_BODY = icon('<circle cx="12" cy="5" r="2.5"/><path d="M12 8v7m0 0-3 6m3-6 3 6M7 11l5-3 5 3"/>');
const I_LIGHT = icon('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>');
const I_SHIELD = icon('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>');
const I_CAM = icon('<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>');
const I_UP = icon('<path d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16"/>');
const I_CHECK = icon('<path d="m5 12 5 5 9-10"/>');

const GUIDE =
  '<svg class="guide" viewBox="0 0 100 160" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="5 5" stroke-linecap="round" aria-hidden="true"><circle cx="50" cy="18" r="10"/><path d="M50 30v50M50 80l-12 38 2 36M50 80l12 38-2 36M50 42l-14 24M50 42l16 22"/></svg>';

const EMPTY_BARS = '<span class="mut">Each rep appears here as a bar</span>';

const TEMPLATE = `
  <div class="page-head">
    <h2>Kinetiq</h2>
    <p class="mut">Pick your exercise (or leave it on Auto) and film with your whole body in frame, side-on if you can. Pose tracking runs on your device. On Auto, three still frames are sent to a vision model to name the exercise; pick an exercise yourself to send nothing.</p>
  </div>

  <div class="tips">
    <span class="tip">${I_SIDE} Side view</span>
    <span class="tip">${I_BODY} Full body in frame</span>
    <span class="tip">${I_LIGHT} Good light</span>
    <span class="tip">${I_SHIELD} Coaching, not medical advice</span>
  </div>

  <div class="form-grid">
    <div class="card">
      <div class="stage" id="stage" data-state="idle">
        <video id="v" playsinline muted hidden></video>
        <canvas id="cv" width="640" height="480"></canvas>
        <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>

        <div class="overlay ov-idle">
          ${GUIDE}
          <b>Head to toe in frame, side-on if you can</b>
          <span>Start your camera, upload a video, or drop one here.</span>
        </div>
        <div class="overlay ov-busy">
          <div class="spinner" aria-hidden="true"></div>
          <b id="busy-msg">Loading…</b>
        </div>

        <div class="live-badge"><i></i> LIVE</div>
        <div class="hud-reps"><b id="rc2">0</b><span>REPS</span></div>
        <div class="gauge" id="gauge" aria-hidden="true"><i id="gauge-fill"></i><em class="mark"></em></div>
        <div class="hint" id="hint" role="status"></div>
        <div class="hud"><div id="fb" class="fb" role="status" aria-live="polite"></div></div>
      </div>

      <div class="checks" aria-label="Tracking checks">
        <span class="check" id="chk-body" data-state="idle"><i></i><em>Body in frame</em></span>
        <span class="check" id="chk-side" data-state="idle"><i></i><em>Side view</em></span>
        <span class="check" id="chk-move" data-state="idle"><i></i><em>Movement</em></span>
      </div>

      <div class="controls">
        <select id="form-ex" aria-label="Exercise">
          <option value="">Auto-detect exercise</option>
          ${Object.values(EXERCISES).map((e) => `<option value="${e.key}">${e.label}</option>`).join('')}
        </select>
        <button class="btn-primary" id="cam" type="button">${I_CAM} Start camera</button>
        <button class="btn-soft" id="upload" type="button">${I_UP} Upload video</button>
        <input id="vf" type="file" accept="video/*,.mov,.mp4,.m4v,.webm,.avi" hidden>
        <button class="btn-primary" id="stop" type="button" disabled>${I_CHECK} Finish &amp; analyze</button>
      </div>
      <p id="vmsg" class="err" role="alert"></p>
    </div>

    <div class="form-side">
      <div class="card">
        <div class="card-head"><h3>Live</h3><span id="phase" class="pill">Waiting</span></div>
        <div class="stats">
          <div class="stat"><b id="rc">0</b><span>Reps</span></div>
          <div class="stat"><b id="knee">—</b><span>Angle</span></div>
          <div class="stat"><b id="best">—</b><span>Best range</span></div>
        </div>
        <p id="ignored" class="mut small"></p>
      </div>

      <div class="card">
        <div class="card-head"><h3>Set timeline</h3></div>
        <div id="bars" class="bars is-empty">${EMPTY_BARS}</div>
        <p id="repinfo" class="repinfo mut"></p>
        <div class="legend">
          <span><i style="background:var(--ok)"></i>Good rep</span>
          <span><i style="background:var(--ac)"></i>Needs work</span>
          <span>Bar height = range of motion</span>
        </div>
      </div>

      <div class="card" id="res-card" hidden>
        <div id="res-ok">
          <div class="score-wrap">
            <div class="ring" id="ring"><b id="score">0</b><span>/100</span></div>
            <div>
              <h3 id="res-title"></h3>
              <p id="res-sum" class="mut"></p>
            </div>
          </div>
          <div id="meters"></div>
        </div>
        <p id="res-err" class="err" role="alert"></p>
        <div class="row">
          <button class="btn-soft" id="retry" type="button" hidden>Retry analysis</button>
          <button class="btn-soft" id="again" type="button">New set</button>
        </div>
      </div>
    </div>
  </div>
`;

/* ---------- State ---------- */

let v!: HTMLVideoElement;
let cv!: HTMLCanvasElement;
let cx!: CanvasRenderingContext2D;

const detectors: Partial<Record<ModelSize, PoseDetector>> = {};
let stage: Stage = 'idle';
let running = false;
let rafId = 0;
let objectUrl: string | null = null;
let accent = '#e5383b';
let counter: Counter = createCounter('');
let session = 0; // bumped on every new set, so a slow identify reply for an old set is ignored
let isFile = false;
let reps: Rep[] = [];
let selected: number | null = null;
let badFrames = 0;
/* ---------- UI helpers ---------- */

function setStage(next: Stage, message = ''): void {
  stage = next;
  $('stage').dataset.state = next;
  if (message) $('busy-msg').textContent = message;
  $('phase').textContent = PHASE_LABEL[next];
  const locked = next === 'loading' || next === 'analyzing' || next === 'live';
  $<HTMLButtonElement>('cam').disabled = locked;
  $<HTMLButtonElement>('upload').disabled = locked;
  $<HTMLButtonElement>('stop').disabled = next !== 'live';
}

const showError = (text: string): void => {
  $('vmsg').textContent = text;
};

function setFeedback(text: string, good: boolean): void {
  const box = $('fb');
  box.textContent = text;
  box.className = `fb ${good ? 'ok' : 'warn'}`;
}

function setHint(text: string): void {
  const el = $('hint');
  if (el.textContent !== text) el.textContent = text;
}

/** Only touches the DOM when something actually changed (this runs every video frame). */
function setCheck(id: string, state: Check, label: string): void {
  const el = $(id);
  if (el.dataset.state === state && el.dataset.label === label) return;
  el.dataset.state = state;
  el.dataset.label = label;
  const text = el.querySelector('em');
  if (text) text.textContent = label;
}

function resetChecks(): void {
  for (const [id, label] of Object.entries(CHECK_DEFAULTS)) setCheck(id, 'idle', label);
}

function setGauge(angle: number | null): void {
  const fill = $('gauge-fill');
  fill.style.height = angle === null ? '0%' : `${Math.max(0, Math.min(1, angle / 180)) * 100}%`;
}

function repInfo(r: Rep): string {
  const issues = r.flags.length ? r.flags.join(', ') : 'good form';
  return `Rep ${r.index} · ${r.minAngle}°–${r.maxAngle}° · ${issues} · ${r.durationS}s`;
}

function renderReps(): void {
  $('rc').textContent = String(reps.length);
  $('rc2').textContent = String(reps.length);
  $('best').textContent = reps.length ? `${Math.max(...reps.map((r) => r.maxAngle - r.minAngle))}°` : '—';
  $('ignored').textContent = counter.exercise ? `Tracking: ${counter.label}` : '';

  const bars = $('bars');
  bars.classList.toggle('is-empty', reps.length === 0);
  if (reps.length === 0) {
    bars.innerHTML = EMPTY_BARS;
    $('repinfo').textContent = '';
    return;
  }
  const active = selected !== null && selected < reps.length ? selected : reps.length - 1;
  bars.innerHTML = reps
    .map((r, i) => {
      const good = r.fullRange && r.postureOk;
      const height = Math.max(10, Math.min(100, ((r.maxAngle - r.minAngle) / 150) * 100));
      return `<button type="button" class="bar-col ${good ? 'good' : 'bad'}${i === active ? ' active' : ''}" data-i="${i}" style="height:${height}%" aria-label="Rep ${r.index}, range ${r.minAngle} to ${r.maxAngle} degrees"></button>`;
    })
    .join('');
  const shown = reps[active];
  if (shown) $('repinfo').textContent = repInfo(shown);
}

function resetSession(): void {
  counter = createCounter($<HTMLSelectElement>('form-ex').value);
  reps = [];
  selected = null;
  badFrames = 0;
  target = null;
  locked = false;
  detectedPoses = [];
  renderReps();
  resetChecks();
  setHint('');
  setGauge(null);
  $('knee').textContent = '—';
  $('fb').textContent = '';
  $('fb').className = 'fb';
  $('res-card').hidden = true;
  cx.clearRect(0, 0, cv.width, cv.height);
}

/* ---------- Pose model ---------- */

async function loadDetector(size: ModelSize): Promise<PoseDetector> {
  const cached = detectors[size];
  if (cached) return cached;
  try {
    const mod = (await import(/* @vite-ignore */ `${MP_BASE}/+esm`)) as MediaPipeModule;
    const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const created = await mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl(size) },
      runningMode: 'VIDEO',
      numPoses: MAX_PEOPLE,
    });
    detectors[size] = created;
    return created;
  } catch {
    throw new UserFacingError('Could not load the pose model. Check your internet connection (it downloads on first use) and try again.');
  }
}

/* ---------- Geometry ---------- */

/** How "side-on" is the body? Compares shoulder width with torso length. */
function viewState(p: Landmark[]): { state: Check; ratio: number } {
  const ls = p[11];
  const rs = p[12];
  const lh = p[23];
  const rh = p[24];
  if (!ls || !rs || !lh || !rh) return { state: 'bad', ratio: 1 };
  const w = cv.width;
  const h = cv.height;
  const span = Math.abs(ls.x - rs.x) * w;
  const torso = Math.hypot(((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2) * w, ((ls.y + rs.y) / 2 - (lh.y + rh.y) / 2) * h);
  const ratio = torso > 0 ? span / torso : 1;
  return { state: ratio < SIDE_OK ? 'ok' : ratio < SIDE_MAX ? 'warn' : 'bad', ratio };
}

/* ---------- Target person ---------- */

let target: Pt | null = null; // where the person we follow was last seen (normalized frame coordinates)
let locked = false; // true once the user tapped a person: never jump to someone else on size alone

/** Centre of the torso (shoulders + hips) and its length, or null if the torso is not visible. */
function torsoOf(p: Landmark[]): { c: Pt; len: number } | null {
  const pts = [11, 12, 23, 24].map((i) => p[i]);
  if (pts.some((q) => !q || (q.visibility ?? 0) < 0.4)) return null;
  const c = { x: pts.reduce((a, q) => a + q.x, 0) / 4, y: pts.reduce((a, q) => a + q.y, 0) / 4 };
  const len = Math.hypot((((p[11].x + p[12].x) - (p[23].x + p[24].x)) / 2) * (cv.width / cv.height), ((p[11].y + p[12].y) - (p[23].y + p[24].y)) / 2);
  return { c, len };
}

const gap = (a: Pt, b: Pt): number => Math.hypot((a.x - b.x) * (cv.width / cv.height), a.y - b.y);

/** Index of the person to follow: nearest to where we last saw them; at the start, the biggest and most central one. */
function pickTarget(poses: Landmark[][]): number {
  let best = -1;
  let bestScore = -Infinity;
  poses.forEach((p, i) => {
    const t = torsoOf(p);
    if (!t) return;
    const score = target ? -gap(t.c, target) : t.len * (1 - 0.6 * gap(t.c, { x: 0.5, y: 0.5 }));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best >= 0 && target) {
    const t = torsoOf(poses[best]);
    if (t && gap(t.c, target) > FOLLOW_DIST) {
      if (locked) return -1; // our person left the frame: wait for them rather than switch
      target = null;
      return pickTarget(poses);
    }
  }
  if (best >= 0) {
    const t = torsoOf(poses[best]);
    if (t) target = t.c;
  }
  return best;
}

function onCanvasTap(ev: MouseEvent): void {
  if (!running || !detectedPoses.length) return;
  const box = cv.getBoundingClientRect();
  const tap = { x: (ev.clientX - box.left) / box.width, y: (ev.clientY - box.top) / box.height };
  let best = -1;
  let bestGap = Infinity;
  detectedPoses.forEach((p, i) => {
    const t = torsoOf(p);
    if (t && gap(t.c, tap) < bestGap) {
      bestGap = gap(t.c, tap);
      best = i;
    }
  });
  const chosen = best >= 0 ? torsoOf(detectedPoses[best]) : null;
  if (!chosen) return;
  target = chosen.c;
  locked = true;
  counter = createCounter($<HTMLSelectElement>('form-ex').value);
  reps = [];
  renderReps();
}

let detectedPoses: Landmark[][] = [];

/** Other people are drawn faint so you can see who is being ignored. */
function drawOthers(poses: Landmark[][], skip: number): void {
  const w = cv.width;
  const h = cv.height;
  cx.save();
  cx.globalAlpha = 0.35;
  cx.lineWidth = Math.max(2, w / 250);
  cx.strokeStyle = '#fff';
  poses.forEach((p, i) => {
    if (i === skip) return;
    for (const [a, b] of BONES) {
      const q = p[a];
      const r = p[b];
      if (!q || !r || (q.visibility ?? 1) < 0.4 || (r.visibility ?? 1) < 0.4) continue;
      cx.beginPath();
      cx.moveTo(q.x * w, q.y * h);
      cx.lineTo(r.x * w, r.y * h);
      cx.stroke();
    }
  });
  cx.restore();
}

/* ---------- Rep detection ---------- */

const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const BODY_POINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

function drawPose(points: Landmark[], vertex: number | null, deg: number | null): void {
  const w = cv.width;
  const h = cv.height;
  cx.lineJoin = 'round';
  cx.lineCap = 'round';
  cx.lineWidth = Math.max(3, w / 160);
  cx.strokeStyle = accent;
  const radius = Math.max(5, w / 110);
  const seen = (p?: Landmark): p is Landmark => !!p && (p.visibility ?? 1) >= 0.4;
  for (const [a, b] of BONES) {
    const p = points[a];
    const q = points[b];
    if (!seen(p) || !seen(q)) continue;
    cx.beginPath();
    cx.moveTo(p.x * w, p.y * h);
    cx.lineTo(q.x * w, q.y * h);
    cx.stroke();
  }
  for (const i of BODY_POINTS) {
    const p = points[i];
    if (!seen(p)) continue;
    cx.beginPath();
    cx.arc(p.x * w, p.y * h, radius, 0, Math.PI * 2);
    cx.fillStyle = '#fff';
    cx.fill();
    cx.lineWidth = 3;
    cx.stroke();
  }

  const k = vertex !== null ? points[vertex] : undefined;
  if (k && deg !== null) {
    cx.font = `600 ${Math.max(14, w / 36)}px Inter, system-ui, sans-serif`;
    cx.fillStyle = '#fff';
    cx.shadowColor = 'rgb(0 0 0 / .8)';
    cx.shadowBlur = 6;
    cx.fillText(`${Math.round(deg)}°`, k.x * w + radius + 8, k.y * h);
    cx.shadowBlur = 0;
  }
}

function onPose(p: Landmark[], now: number, world?: Landmark[]): void {
  const bodyVisible = [11, 12, 23, 24].every((i) => (p[i]?.visibility ?? 0) >= MIN_VISIBILITY);
  const view = viewState(p);
  setCheck('chk-body', bodyVisible ? 'ok' : 'bad', bodyVisible ? 'Body in frame' : 'Body not visible');
  setCheck('chk-side', view.state, view.state === 'ok' ? 'Side view' : view.state === 'warn' ? 'Turn a bit more sideways' : 'Facing the camera');

  if (!bodyVisible) {
    badFrames += 1;
    if (badFrames > GRACE_FRAMES) setHint('Step back: I need to see your whole body');
    return;
  }
  badFrames = 0;
  setHint(view.state === 'bad' ? 'Turn side-on for lean and elbow checks (rep counting still works)' : '');

  const rep = counter.update(p, now, cv.width / cv.height, world);
  const deg = counter.angle;
  $('knee').textContent = deg === null ? '—' : `${Math.round(deg)}°`;
  setGauge(deg);
  setCheck('chk-move', counter.exercise ? 'ok' : 'warn', counter.exercise ?? 'Detecting movement…');
  if ('debug' in counter) {
    const dbg = (counter as unknown as { debug: Record<string, { range: number }> }).debug;
    const text = Object.entries(dbg).map(([j, d]) => `${j} ${d.range}°`).join(' · ');
    if ($('ignored').textContent !== text) $('ignored').textContent = text ? `Joint movement: ${text}` : '';
  }
  if (rep) {
    reps.push(rep);
    selected = null;
    renderReps();
    setFeedback(rep.flags.length ? rep.flags.join(' · ') : 'Good rep ✔', rep.flags.length === 0);
  }
  drawPose(p, counter.vertex, deg);
}

/* ---------- Exercise identification (vision model) ---------- */

/** Current video frame as a small JPEG data URL (keeps the upload to a few tens of KB). */
function grabFrame(): string {
  const w = 384;
  const h = Math.round((w * (v.videoHeight || 480)) / (v.videoWidth || 640));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')?.drawImage(v, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.7);
}

function seekTo(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = seconds;
    setTimeout(done, 2000); // never hang on a codec that does not fire 'seeked'
  });
}

/** Ask the vision model which exercise this is, then switch to that exercise's rules. */
async function identify(frames: string[], mine: number): Promise<void> {
  if ($<HTMLSelectElement>('form-ex').value) return; // the user already chose
  try {
    const { exercise } = await api.identifyExercise(frames);
    const cfg = EXERCISES[exercise];
    if (mine !== session || !cfg || $<HTMLSelectElement>('form-ex').value) return; // stale, unknown or "other": stay on auto
    counter = createCounter(cfg.label);
    reps = [];
    renderReps();
    $('ignored').textContent = `Exercise identified by the vision model: ${cfg.label}`;
  } catch {
    $('ignored').textContent = 'Could not identify the exercise automatically. Pick it from the list for the best result.';
  }
}

/** Uploaded video: sample three moments before playback starts so counting uses the right rules from rep 1. */
async function identifyFile(mine: number): Promise<void> {
  if ($<HTMLSelectElement>('form-ex').value || !(v.duration > 1)) return;
  const frames: string[] = [];
  for (const at of [0.2, 0.45, 0.7]) {
    await seekTo(v.duration * at);
    frames.push(grabFrame());
  }
  await seekTo(0);
  await identify(frames, mine);
}

/** Live camera: sample one frame a second for three seconds, then identify. */
function identifyLive(mine: number): void {
  if ($<HTMLSelectElement>('form-ex').value) return;
  const frames: string[] = [];
  const timer = window.setInterval(() => {
    if (mine !== session || !running) {
      window.clearInterval(timer);
      return;
    }
    frames.push(grabFrame());
    if (frames.length === 3) {
      window.clearInterval(timer);
      void identify(frames, mine);
    }
  }, 1500);
}

/* ---------- Capture lifecycle ---------- */

function fitCanvas(): void {
  const w = v.videoWidth || 640;
  const h = v.videoHeight || 480;
  const scale = Math.min(1, 960 / Math.max(w, h));
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  $('stage').style.setProperty('--arn', String(cv.width / cv.height));
}

function stopCapture(): void {
  running = false;
  cancelAnimationFrame(rafId);
  v.onerror = null;
  v.onloadeddata = null;
  v.onended = null;
  v.pause();
  if (v.srcObject instanceof MediaStream) v.srcObject.getTracks().forEach((t) => t.stop());
  v.srcObject = null;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    v.removeAttribute('src');
    v.load();
  }
}

function fail(error: unknown): void {
  stopCapture();
  setStage('idle');
  const name = error instanceof DOMException ? error.name : '';
  if (error instanceof UserFacingError) showError(error.message);
  else if (name === 'NotAllowedError') showError('Camera access is blocked. Allow it from the lock icon in the address bar, then try again.');
  else if (name === 'NotFoundError') showError('No camera found on this device. Try uploading a video instead.');
  else showError(`Something went wrong: ${messageOf(error)}`);
}

function loop(model: PoseDetector): void {
  if (!running) return;
  try {
    if (v.readyState >= 2) {
      cx.drawImage(v, 0, 0, cv.width, cv.height);
      const result = model.detectForVideo(v, performance.now());
      detectedPoses = result.landmarks;
      const who = pickTarget(result.landmarks);
      drawOthers(result.landmarks, who);
      const pose = result.landmarks[who];
      if (pose) onPose(pose, v.currentTime * 1000, result.worldLandmarks?.[who]);
      if (result.landmarks.length > 1 && !locked) setHint('Several people detected: tap the person you want me to follow');
    }
  } catch (error) {
    fail(error);
    return;
  }
  rafId = requestAnimationFrame(() => loop(model));
}

async function begin(size: ModelSize): Promise<void> {
  setStage('loading', 'Loading pose model… the first time takes a few seconds');
  const model = await loadDetector(size);
  accent = getComputedStyle(document.documentElement).getPropertyValue('--ac2').trim() || accent;
  const mine = session;
  if (isFile) await identifyFile(mine);
  await v.play();
  fitCanvas();
  running = true;
  setStage('live');
  if (!isFile) identifyLive(mine);
  loop(model);
}

function prepare(): void {
  session += 1;
  showError('');
  stopCapture();
  resetSession();
}

async function startCamera(): Promise<void> {
  prepare();
  isFile = false;
  setStage('loading', 'Starting camera…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new UserFacingError('The camera needs a secure page (https or localhost). Try uploading a video instead.');
    }
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    await begin('full'); // live camera: keep it fast enough to run in real time
  } catch (error) {
    fail(error);
  }
}

function startFile(file: File): void {
  prepare();
  isFile = true;
  setStage('loading', `Loading ${file.name}…`);
  objectUrl = URL.createObjectURL(file);
  v.src = objectUrl;
  v.onerror = () => {
    fail(new UserFacingError("This browser can't play that video (iPhone .mov files often use HEVC). Convert it to MP4 (H.264) and try again."));
  };
  v.onloadeddata = () => {
    void begin('heavy').catch(fail); // uploaded video: accuracy matters more than speed
  };
  v.onended = () => {
    if (stage === 'live') void finish();
  };
}

/* ---------- Analysis ---------- */

function meterRow(label: string, hits: number, total: number): string {
  const pct = total > 0 ? Math.round((hits / total) * 100) : 0;
  return `<div class="meter"><div class="meter-top"><span>${label}</span><b>${hits}/${total}</b></div><div class="track"><i style="width:${pct}%"></i></div></div>`;
}

function showResult(result: FormResult): void {
  const n = reps.length;
  const tempo = n ? reps.reduce((sum, r) => sum + r.durationS, 0) / n : 0;
  $('res-card').hidden = false;
  $('res-ok').hidden = false;
  $('res-err').textContent = '';
  $('retry').hidden = true;
  $('ring').style.setProperty('--p', String(Math.max(0, Math.min(100, result.score))));
  $('score').textContent = String(Math.round(result.score));
  $('res-title').textContent = `${result.rep_count} rep${result.rep_count === 1 ? '' : 's'} of ${result.exercise}`;
  $('res-sum').textContent = result.summary; // textContent: AI text is never parsed as HTML
  const issues = Object.entries(result.flags ?? {}).sort((a, b) => b[1] - a[1]);
  $('meters').innerHTML =
    meterRow('Full range of motion', reps.filter((r) => r.fullRange).length, n) +
    meterRow('Good posture', reps.filter((r) => r.postureOk).length, n) +
    issues.map(([text, count]) => meterRow(escapeHtml(text), n - count, n)).join('') +
    `<p class="mut small">Average tempo ${tempo.toFixed(1)} s per rep</p>`;
}

const escapeHtml = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function showAnalysisError(error: unknown): void {
  $('res-card').hidden = false;
  $('res-ok').hidden = true;
  $('res-err').textContent = `Couldn't analyze: ${messageOf(error)}. Your reps are saved, so you can retry.`;
  $('retry').hidden = false;
}

async function analyze(): Promise<void> {
  setStage('analyzing', 'Analyzing your reps…');
  try {
    showResult(await api.saveForm(counter.exercise ?? 'Exercise', reps.map(toFormRep)));
  } catch (error) {
    showAnalysisError(error);
  } finally {
    setStage('done');
  }
}

async function finish(): Promise<void> {
  stopCapture();
  if (reps.length === 0) {
    setStage('idle');
    showError('No complete reps detected. Film with your full body in frame and good light, pick the exercise from the list, and try again.');
    return;
  }
  await analyze();
}

function newSet(): void {
  prepare();
  $('stage').style.removeProperty('--arn');
  setStage('idle');
}

/** Called when the user leaves the Kinetiq tab, so the camera never stays on in the background. */
export function stopForm(): void {
  if (stage === 'loading' || stage === 'live') {
    stopCapture();
    resetSession();
    setStage('idle');
  }
}

export function initForm(): void {
  $('form').innerHTML = TEMPLATE;
  v = $<HTMLVideoElement>('v');
  cv = $<HTMLCanvasElement>('cv');
  const context = cv.getContext('2d');
  if (!context) throw new Error('Canvas is not supported in this browser');
  cx = context;

  $('cam').addEventListener('click', () => void startCamera());
  $('upload').addEventListener('click', () => $('vf').click());
  $('stop').addEventListener('click', () => void finish());
  $('retry').addEventListener('click', () => void analyze());
  $('again').addEventListener('click', newSet);

  $('bars').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const bar = target.closest<HTMLElement>('[data-i]');
    if (!bar) return;
    selected = Number(bar.dataset.i);
    renderReps();
  });

  $('vf').addEventListener('change', (ev) => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    input.value = ''; // lets you pick the same file twice
    if (file) startFile(file);
  });

  cv.addEventListener('click', onCanvasTap);
  cv.style.cursor = 'pointer';

  const stageBox = $('stage');
  stageBox.addEventListener('dragover', (ev) => ev.preventDefault());
  stageBox.addEventListener('drop', (ev) => {
    ev.preventDefault();
    if (stage === 'loading' || stage === 'live' || stage === 'analyzing') return;
    const file = ev.dataTransfer?.files[0];
    if (file && file.type.startsWith('video/')) startFile(file);
  });

  setStage('idle');
}
