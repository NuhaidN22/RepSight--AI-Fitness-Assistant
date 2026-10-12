import { api } from './api';
import type { FormResult, RepMetrics } from './types';
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
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks: Landmark[][] };
}
interface MediaPipeModule {
  FilesetResolver: { forVisionTasks(wasmPath: string): Promise<unknown> };
  PoseLandmarker: { createFromOptions(fileset: unknown, options: object): Promise<PoseDetector> };
}

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/* ---------- Tunable thresholds (heuristics, not validated science: change them freely) ---------- */
const MIN_VISIBILITY = 0.5; // shoulder, hip, knee and ankle must each be at least this visible
const SIDE_OK = 0.35; // shoulder-width / torso-length below this = clean side view
const SIDE_MAX = 0.55; // above this = facing the camera, so a squat cannot be judged
const MIN_HIP_DROP = 0.25; // hips must lower by >= 25% of torso length for a rep to count as a squat
const GRACE_FRAMES = 8; // tolerate ~0.25 s of tracking flicker before discarding a half-finished rep

type Stage = 'idle' | 'loading' | 'live' | 'analyzing' | 'done';
type Check = 'idle' | 'ok' | 'warn' | 'bad';
interface RepState {
  phase: 'up' | 'down';
  minKnee: number;
  maxDepth: number;
  maxLean: number;
  t0: number;
  hip0: number; // hip height (px) while standing, just before this rep started
  torso: number; // torso length (px) while standing
  maxHipY: number; // lowest hip position reached during this rep
}

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
  'chk-squat': 'Squat pattern',
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
    <h2>Squat form check</h2>
    <p class="mut">Film from the side with your whole body in frame. Pose tracking runs on your device, so the video never leaves your browser.</p>
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
          <b>Stand sideways, head to toe in frame</b>
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
        <span class="check" id="chk-squat" data-state="idle"><i></i><em>Squat pattern</em></span>
      </div>

      <div class="controls">
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
          <div class="stat"><b id="knee">—</b><span>Knee angle</span></div>
          <div class="stat"><b id="best">—</b><span>Deepest</span></div>
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
          <span>Bar height = depth</span>
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

let detector: PoseDetector | undefined;
let stage: Stage = 'idle';
let running = false;
let rafId = 0;
let objectUrl: string | null = null;
let accent = '#e5383b';
let reps: RepMetrics[] = [];
let ignored = 0;
let selected: number | null = null;
let badFrames = 0;
let stand: { hipY: number; torso: number } | null = null;
let st: RepState = freshState();

function freshState(): RepState {
  return { phase: 'up', minKnee: 180, maxDepth: -1, maxLean: 0, t0: 0, hip0: 0, torso: 0, maxHipY: 0 };
}

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

function setGauge(knee: number | null): void {
  const fill = $('gauge-fill');
  if (knee === null) {
    fill.style.height = '0%';
    $('gauge').classList.remove('reached');
    return;
  }
  const flexion = Math.max(0, Math.min(1, (180 - knee) / 120)); // 180° = straight leg, 60° = very deep
  fill.style.height = `${flexion * 100}%`;
  $('gauge').classList.toggle('reached', knee < 125); // 125° is the "this counts as a rep" line
}

function repInfo(r: RepMetrics, i: number): string {
  const depth = r.depth_ok ? 'depth reached' : 'too shallow';
  const torso = r.torso_ok ? 'torso upright' : `torso leaning ${r.max_torso_lean}°`;
  return `Rep ${i + 1} · knee ${r.min_knee_angle}° · ${depth} · ${torso} · ${r.tempo_s}s`;
}

function renderReps(): void {
  $('rc').textContent = String(reps.length);
  $('rc2').textContent = String(reps.length);
  $('best').textContent = reps.length ? `${Math.min(...reps.map((r) => r.min_knee_angle))}°` : '—';
  $('ignored').textContent = ignored
    ? `${ignored} movement${ignored === 1 ? '' : 's'} ignored because the hips barely moved (not a squat).`
    : '';

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
      const good = r.depth_ok === 1 && r.torso_ok === 1;
      const height = Math.max(10, Math.min(100, ((180 - r.min_knee_angle) / 150) * 100));
      return `<button type="button" class="bar-col ${good ? 'good' : 'bad'}${i === active ? ' active' : ''}" data-i="${i}" style="height:${height}%" aria-label="Rep ${i + 1}, knee ${r.min_knee_angle} degrees"></button>`;
    })
    .join('');
  const shown = reps[active];
  if (shown) $('repinfo').textContent = repInfo(shown, active);
}

function resetSession(): void {
  reps = [];
  ignored = 0;
  selected = null;
  badFrames = 0;
  stand = null;
  st = freshState();
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

async function loadDetector(): Promise<PoseDetector> {
  if (detector) return detector;
  try {
    const mod = (await import(/* @vite-ignore */ `${MP_BASE}/+esm`)) as MediaPipeModule;
    const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    detector = await mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    return detector;
  } catch {
    throw new UserFacingError('Could not load the pose model. Check your internet connection (it downloads on first use) and try again.');
  }
}

/* ---------- Geometry ---------- */

const angle = (a: Pt, b: Pt, c: Pt): number => {
  const r = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  const d = Math.abs((r * 180) / Math.PI);
  return d > 180 ? 360 - d : d;
};

const LEFT = [11, 23, 25, 27]; // shoulder, hip, knee, ankle
const RIGHT = [12, 24, 26, 28];

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

/* ---------- Rep detection ---------- */

function finishRep(now: number): void {
  const drop = st.torso > 0 ? (st.maxHipY - st.hip0) / st.torso : 0;
  if (drop < MIN_HIP_DROP) {
    ignored += 1;
    setCheck('chk-squat', 'bad', 'Not a squat pattern');
    setFeedback("That didn't look like a squat (hips barely moved)", false);
    renderReps();
    return;
  }

  const rep: RepMetrics = {
    min_knee_angle: Math.round(st.minKnee),
    depth_ok: st.maxDepth >= -0.01 ? 1 : 0,
    torso_ok: st.maxLean < 55 ? 1 : 0,
    max_torso_lean: Math.round(st.maxLean),
    tempo_s: Number(((now - st.t0) / 1000).toFixed(1)),
  };
  reps.push(rep);
  selected = null;
  setCheck('chk-squat', 'ok', 'Squat pattern');
  renderReps();
  if (!rep.depth_ok) setFeedback('Go deeper: hips to knee level', false);
  else if (!rep.torso_ok) setFeedback('Chest up: torso leaning too far', false);
  else setFeedback('Good rep ✔', true);
}

function drawPose(points: Landmark[], knee: number): void {
  const w = cv.width;
  const h = cv.height;
  cx.lineJoin = 'round';
  cx.lineCap = 'round';
  cx.lineWidth = Math.max(3, w / 160);
  cx.strokeStyle = accent;
  cx.beginPath();
  points.forEach((p, i) => (i === 0 ? cx.moveTo(p.x * w, p.y * h) : cx.lineTo(p.x * w, p.y * h)));
  cx.stroke();

  const radius = Math.max(5, w / 110);
  for (const p of points) {
    cx.beginPath();
    cx.arc(p.x * w, p.y * h, radius, 0, Math.PI * 2);
    cx.fillStyle = '#fff';
    cx.fill();
    cx.lineWidth = 3;
    cx.strokeStyle = accent;
    cx.stroke();
  }

  const k = points[2];
  if (k) {
    cx.font = `600 ${Math.max(14, w / 36)}px Inter, system-ui, sans-serif`;
    cx.fillStyle = '#fff';
    cx.shadowColor = 'rgb(0 0 0 / .8)';
    cx.shadowBlur = 6;
    cx.fillText(`${Math.round(knee)}°`, k.x * w + radius + 8, k.y * h);
    cx.shadowBlur = 0;
  }
}

function onPose(p: Landmark[], now: number): void {
  const vis = (ids: number[]): number => ids.reduce((sum, i) => sum + (p[i]?.visibility ?? 0), 0);
  const ids = vis(LEFT) >= vis(RIGHT) ? LEFT : RIGHT;
  const [s, h, k, a] = ids.map((i) => p[i]);
  if (!s || !h || !k || !a) return;

  // Gate 1: are all four joints actually visible (not guessed by the model)?
  const bodyVisible = [s, h, k, a].every((pt) => (pt.visibility ?? 0) >= MIN_VISIBILITY);
  // Gate 2: are we looking at the person from the side?
  const view = viewState(p);
  setCheck('chk-body', bodyVisible ? 'ok' : 'bad', bodyVisible ? 'Body in frame' : 'Legs not visible');
  setCheck(
    'chk-side',
    view.state,
    view.state === 'ok' ? 'Side view' : view.state === 'warn' ? 'Turn a bit more sideways' : 'Facing the camera',
  );

  if (!bodyVisible || view.state === 'bad') {
    badFrames += 1;
    if (badFrames > GRACE_FRAMES) {
      setHint(!bodyVisible ? 'Step back: I need to see your whole body' : 'Turn sideways to the camera');
      st = freshState(); // discard any half-finished rep built from unreliable points
      stand = null;
      setGauge(null);
      $('knee').textContent = '—';
    }
    return;
  }
  badFrames = 0;
  setHint('');

  // Angles use pixel coordinates; normalized x and y have different scales on non-square video.
  const px = (l: Landmark): Pt => ({ x: l.x * cv.width, y: l.y * cv.height });
  const S = px(s);
  const H = px(h);
  const K = px(k);
  const A = px(a);
  const knee = angle(H, K, A);
  const lean = Math.abs((Math.atan2(S.x - H.x, H.y - S.y) * 180) / Math.PI);
  const torso = Math.hypot(S.x - H.x, S.y - H.y);
  $('knee').textContent = `${Math.round(knee)}°`;
  setGauge(knee);

  if (st.phase === 'up' && knee > 160) stand = { hipY: H.y, torso }; // remember the standing baseline
  if (st.phase === 'up' && knee < 140) {
    st = {
      phase: 'down',
      minKnee: knee,
      maxDepth: -1,
      maxLean: 0,
      t0: now,
      hip0: stand?.hipY ?? H.y,
      torso: stand?.torso ?? torso,
      maxHipY: H.y,
    };
  }
  if (st.phase === 'down') {
    st.minKnee = Math.min(st.minKnee, knee);
    st.maxDepth = Math.max(st.maxDepth, h.y - k.y); // normalized: y grows downward
    st.maxLean = Math.max(st.maxLean, lean);
    st.maxHipY = Math.max(st.maxHipY, H.y);
    if (knee > 160) {
      st.phase = 'up';
      if (st.minKnee < 125) finishRep(now);
    }
  }
  drawPose([s, h, k, a], knee);
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
      const pose = model.detectForVideo(v, performance.now()).landmarks[0];
      if (pose) onPose(pose, v.currentTime * 1000);
    }
  } catch (error) {
    fail(error);
    return;
  }
  rafId = requestAnimationFrame(() => loop(model));
}

async function begin(): Promise<void> {
  setStage('loading', 'Loading pose model… the first time takes a few seconds');
  const model = await loadDetector();
  accent = getComputedStyle(document.documentElement).getPropertyValue('--ac2').trim() || accent;
  await v.play();
  fitCanvas();
  running = true;
  setStage('live');
  loop(model);
}

function prepare(): void {
  showError('');
  stopCapture();
  resetSession();
}

async function startCamera(): Promise<void> {
  prepare();
  setStage('loading', 'Starting camera…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new UserFacingError('The camera needs a secure page (https or localhost). Try uploading a video instead.');
    }
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    await begin();
  } catch (error) {
    fail(error);
  }
}

function startFile(file: File): void {
  prepare();
  setStage('loading', `Loading ${file.name}…`);
  objectUrl = URL.createObjectURL(file);
  v.src = objectUrl;
  v.onerror = () => {
    fail(new UserFacingError("This browser can't play that video (iPhone .mov files often use HEVC). Convert it to MP4 (H.264) and try again."));
  };
  v.onloadeddata = () => {
    void begin().catch(fail);
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
  const tempo = n ? reps.reduce((sum, r) => sum + r.tempo_s, 0) / n : 0;
  $('res-card').hidden = false;
  $('res-ok').hidden = false;
  $('res-err').textContent = '';
  $('retry').hidden = true;
  $('ring').style.setProperty('--p', String(Math.max(0, Math.min(100, result.score))));
  $('score').textContent = String(Math.round(result.score));
  $('res-title').textContent = `${result.rep_count} rep${result.rep_count === 1 ? '' : 's'} analyzed`;
  $('res-sum').textContent = result.summary; // textContent: AI text is never parsed as HTML
  $('meters').innerHTML =
    meterRow('Depth reached', reps.filter((r) => r.depth_ok === 1).length, n) +
    meterRow('Torso upright', reps.filter((r) => r.torso_ok === 1).length, n) +
    `<p class="mut small">Average tempo ${tempo.toFixed(1)} s per rep</p>`;
}

function showAnalysisError(error: unknown): void {
  $('res-card').hidden = false;
  $('res-ok').hidden = true;
  $('res-err').textContent = `Couldn't analyze: ${messageOf(error)}. Your reps are saved, so you can retry.`;
  $('retry').hidden = false;
}

async function analyze(): Promise<void> {
  setStage('analyzing', 'Analyzing your reps…');
  try {
    showResult(await api.analyzeForm('squat', reps));
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
    showError(
      ignored > 0
        ? "I saw movement but none of it looked like a squat. Film a side view of a squat with your full body in frame, then try again."
        : 'No complete reps detected. Film from the side with your full body in frame and good light, then try again.',
    );
    return;
  }
  await analyze();
}

function newSet(): void {
  prepare();
  $('stage').style.removeProperty('--arn');
  setStage('idle');
}

/** Called when the user leaves the Form Check tab, so the camera never stays on in the background. */
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