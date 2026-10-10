import { api } from './api';
import type { NewSet, Routine, RoutineItem, WorkoutSet } from './types';
import { $, esc, messageOf, setBusy, toast } from './ui';

const REST_SECONDS = 90;

let history: WorkoutSet[] = [];
let draft: RoutineItem[] = [];
let restTimer: number | undefined;
let rpe: number | null = null;

const RPE_PILLS = Array.from({ length: 10 }, (_, i) => i + 1)
  .map((n) => `<button type="button" class="rpe-pill" data-rpe="${n}" aria-pressed="false">${n}</button>`)
  .join('');

const TEMPLATE = `
  <div class="page-head">
    <h2>Today's workout</h2>
    <p class="mut">Log sets, beat your numbers, and keep your rest honest.</p>
  </div>

  <div class="log-grid">
    <div class="card">
      <div class="card-head"><h3>Log a set</h3></div>
      <form id="set-form" novalidate>
        <label class="field"><span>Exercise</span><select id="ex"></select></label>

        <div class="fields">
          <div class="field">
            <span>Reps</span>
            <div class="stepper">
              <button type="button" data-step="reps" data-d="-1" aria-label="Fewer reps">−</button>
              <input id="reps" type="number" inputmode="numeric" min="1" max="100" placeholder="0" aria-label="Reps">
              <button type="button" data-step="reps" data-d="1" aria-label="More reps">+</button>
            </div>
          </div>
          <div class="field">
            <span>Weight (kg)</span>
            <div class="stepper">
              <button type="button" data-step="wt" data-d="-2.5" aria-label="Less weight">−</button>
              <input id="wt" type="number" inputmode="decimal" step="0.5" min="0" max="1000" placeholder="0" aria-label="Weight in kg">
              <button type="button" data-step="wt" data-d="2.5" aria-label="More weight">+</button>
            </div>
          </div>
        </div>

        <div class="field">
          <span>Effort (RPE) <small class="mut">optional · tap again to clear</small></span>
          <div class="rpe" id="rpe-pills" role="group" aria-label="RPE">${RPE_PILLS}</div>
        </div>

        <p id="set-err" class="err" role="alert"></p>
        <button class="btn-primary" id="add" type="submit">Log set</button>
      </form>

      <div id="rest" class="rest" hidden>
        <span id="rest-text"></span>
        <div class="bar"><i id="rest-bar"></i></div>
        <button type="button" id="rest-skip" class="btn-ghost">Skip</button>
      </div>
    </div>

    <div class="side">
      <div class="card">
        <div class="card-head"><h3>Latest session</h3><span id="session-pill" class="pill"></span></div>
        <div id="stats" class="stats"></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Routines</h3></div>
        <div id="routines"></div>
        <details class="builder">
          <summary>＋ Create routine</summary>
          <form id="routine-form" novalidate>
            <input id="rn" placeholder="Routine name (e.g. Push day)" maxlength="40" aria-label="Routine name">
            <div class="row">
              <select id="rex" aria-label="Exercise"></select>
              <input id="rs" type="number" value="3" min="1" max="20" aria-label="Sets" title="sets" class="mini">
              <span class="mut">×</span>
              <input id="rr" type="number" value="8" min="1" max="100" aria-label="Reps" title="reps" class="mini">
              <button class="btn-soft" id="add-ex" type="button">Add</button>
            </div>
            <div id="draft" class="chips"></div>
            <button class="btn-primary" id="save-routine" type="submit" disabled>Save routine</button>
          </form>
        </details>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>History</h3></div>
    <div id="hist"></div>
  </div>
`;

/* ---------- helpers ---------- */

const fmt = (n: number): string => Math.round(n).toLocaleString();
const dayOf = (date: string): string => date.slice(0, 10);

function dayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  if (day === new Date().toLocaleDateString('en-CA')) return 'Today';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/* ---------- Log a set ---------- */

function setRpe(value: number | null): void {
  rpe = value;
  document.querySelectorAll<HTMLElement>('.rpe-pill').forEach((pill) => {
    const on = Number(pill.dataset.rpe) === value;
    pill.classList.toggle('on', on);
    pill.setAttribute('aria-pressed', String(on));
  });
}

function onStep(button: HTMLElement): void {
  const input = $<HTMLInputElement>(button.dataset.step ?? '');
  const delta = Number(button.dataset.d);
  const min = Number(input.min || 0);
  const max = Number(input.max || Infinity);
  const current = Number(input.value) || 0;
  input.value = String(Math.min(max, Math.max(min, Math.round((current + delta) * 10) / 10)));
}

function readSet(): NewSet | string {
  const exercise = $<HTMLSelectElement>('ex').value;
  const reps = Number($<HTMLInputElement>('reps').value);
  const weightRaw = $<HTMLInputElement>('wt').value;

  if (!exercise) return 'Pick an exercise.';
  if (!Number.isInteger(reps) || reps < 1 || reps > 100) return 'Reps must be a whole number from 1 to 100.';

  const weight = weightRaw === '' ? 0 : Number(weightRaw);
  if (Number.isNaN(weight) || weight < 0 || weight > 1000) return 'Weight must be between 0 and 1000 kg.';

  return { exercise, reps, weight, rpe };
}

async function onAddSet(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const parsed = readSet();
  const errorBox = $('set-err');
  if (typeof parsed === 'string') {
    errorBox.textContent = parsed;
    return;
  }
  errorBox.textContent = '';

  const previousBest = Math.max(0, ...history.filter((s) => s.exercise === parsed.exercise).map((s) => s.weight));
  const button = $<HTMLButtonElement>('add');
  setBusy(button, true, 'Saving…');
  try {
    await api.addSet(parsed);
    const isPr = previousBest > 0 && parsed.weight > previousBest;
    toast(isPr ? `🎉 New PR! ${parsed.exercise} ${parsed.weight} kg` : `Logged ${parsed.exercise}: ${parsed.reps} × ${parsed.weight} kg`);
    startRest(REST_SECONDS);
    await loadHistory(); // reps/weight stay filled so the next set is one tap
  } catch (error) {
    toast(messageOf(error), 'err');
  } finally {
    setBusy(button, false, 'Log set');
  }
}

/** When the exercise changes, prefill reps/weight from the last time you did it. */
function prefillFromHistory(): void {
  const name = $<HTMLSelectElement>('ex').value;
  const last = history.find((s) => s.exercise === name);
  if (!last) return;
  $<HTMLInputElement>('reps').value = String(last.reps);
  $<HTMLInputElement>('wt').value = String(last.weight);
}

/* ---------- Rest timer ---------- */

function stopRest(): void {
  if (restTimer !== undefined) window.clearInterval(restTimer);
  restTimer = undefined;
  $('rest').hidden = true;
}

function startRest(seconds: number): void {
  stopRest();
  const box = $('rest');
  const text = $('rest-text');
  const bar = $('rest-bar');
  box.hidden = false;
  const endsAt = Date.now() + seconds * 1000; // wall-clock based, so background tabs stay accurate

  const tick = (): void => {
    const left = Math.ceil((endsAt - Date.now()) / 1000);
    if (left <= 0) {
      text.textContent = 'Go! 💪';
      bar.style.width = '0%';
      if (restTimer !== undefined) window.clearInterval(restTimer);
      restTimer = undefined;
      window.setTimeout(() => {
        if (restTimer === undefined) box.hidden = true;
      }, 4000);
      return;
    }
    text.textContent = `Rest ${left}s`;
    bar.style.width = `${(left / seconds) * 100}%`;
  };

  tick();
  restTimer = window.setInterval(tick, 250);
}

/* ---------- Stats + history ---------- */

function renderStats(): void {
  const box = $('stats');
  const pill = $('session-pill');
  const tile = (label: string, value: string): string =>
    `<div class="stat"><b>${value}</b><span>${label}</span></div>`;

  const first = history[0];
  if (!first) {
    pill.textContent = 'No sessions yet';
    box.innerHTML = tile('Sets', '—') + tile('Volume', '—') + tile('Exercises', '—');
    return;
  }
  const day = dayOf(first.date);
  const sets = history.filter((s) => dayOf(s.date) === day);
  const volume = sets.reduce((sum, s) => sum + s.reps * s.weight, 0);
  pill.textContent = dayLabel(day);
  box.innerHTML =
    tile('Sets', String(sets.length)) +
    tile('Volume (kg)', fmt(volume)) +
    tile('Exercises', String(new Set(sets.map((s) => s.exercise)).size));
}

function renderHistory(): void {
  renderStats();
  const box = $('hist');
  if (history.length === 0) {
    box.innerHTML =
      '<div class="empty-state"><div class="emoji">🏋️</div><p><b>No sets yet</b></p><p class="mut">Log your first set and it will show up here.</p></div>';
    return;
  }

  const groups = new Map<string, WorkoutSet[]>();
  for (const s of history.slice(0, 40)) {
    const day = dayOf(s.date);
    const list = groups.get(day);
    if (list) list.push(s);
    else groups.set(day, [s]);
  }

  box.innerHTML = [...groups]
    .map(([day, sets]) => {
      const volume = sets.reduce((sum, s) => sum + s.reps * s.weight, 0);
      const rows = sets
        .map(
          (s) =>
            `<div class="set-row"><span class="ex">${esc(s.exercise)}</span><span>${esc(s.reps)} × ${esc(s.weight)} kg</span></div>`,
        )
        .join('');
      return `<div class="day"><div class="day-head"><b>${esc(dayLabel(day))}</b><span class="mut">${sets.length} sets · ${fmt(volume)} kg</span></div>${rows}</div>`;
    })
    .join('');
}

async function loadHistory(): Promise<void> {
  try {
    history = await api.sets();
    renderHistory();
  } catch (error) {
    $('hist').innerHTML = `<p class="err">${esc(messageOf(error))}</p>`;
    renderStats();
  }
}

/* ---------- Routines ---------- */

function updateSaveState(): void {
  const hasName = $<HTMLInputElement>('rn').value.trim() !== '';
  $<HTMLButtonElement>('save-routine').disabled = !(hasName && draft.length > 0);
}

function renderDraft(): void {
  $('draft').innerHTML = draft
    .map(
      (d, i) =>
        `<span class="chip">${esc(d.exercise)} ${d.sets}×${d.reps}<button type="button" data-rm="${i}" aria-label="Remove ${esc(d.exercise)}">×</button></span>`,
    )
    .join('');
  updateSaveState();
}

function onAddDraft(): void {
  const exercise = $<HTMLSelectElement>('rex').value;
  const sets = Number($<HTMLInputElement>('rs').value);
  const reps = Number($<HTMLInputElement>('rr').value);
  if (!exercise) return toast('Pick an exercise first.', 'err');
  if (!Number.isInteger(sets) || sets < 1 || sets > 20) return toast('Sets must be 1–20.', 'err');
  if (!Number.isInteger(reps) || reps < 1 || reps > 100) return toast('Reps must be 1–100.', 'err');
  draft.push({ exercise, sets, reps });
  renderDraft();
}

async function onSaveRoutine(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const name = $<HTMLInputElement>('rn').value.trim();
  if (!name || draft.length === 0) return;

  const button = $<HTMLButtonElement>('save-routine');
  setBusy(button, true, 'Saving…');
  try {
    await api.addRoutine({ name, items: draft });
    toast(`Saved routine “${name}”`);
    draft = [];
    $<HTMLInputElement>('rn').value = '';
    renderDraft();
    await loadRoutines();
  } catch (error) {
    toast(messageOf(error), 'err');
  } finally {
    setBusy(button, false, 'Save routine');
    updateSaveState();
  }
}

function renderRoutines(routines: Routine[]): void {
  const box = $('routines');
  if (routines.length === 0) {
    box.innerHTML = '<p class="mut empty">No routines yet. Create one below to load your exercises in one tap.</p>';
    return;
  }
  box.innerHTML =
    '<p class="mut hint">Tap an exercise to load it into the logger.</p>' +
    routines
      .map(
        (r) => `
      <div class="routine">
        <div class="routine-head"><b>${esc(r.name)}</b><button type="button" class="link" data-del="${r.id}">delete</button></div>
        <div class="chips">${r.items
          .map(
            (i) =>
              `<button type="button" class="chip-btn" data-ex="${esc(i.exercise)}" data-reps="${i.reps}">${esc(i.exercise)} <small>${i.sets}×${i.reps}</small></button>`,
          )
          .join('')}</div>
      </div>`,
      )
      .join('');
}

async function loadRoutines(): Promise<void> {
  try {
    renderRoutines(await api.routines());
  } catch (error) {
    $('routines').innerHTML = `<p class="err">${esc(messageOf(error))}</p>`;
  }
}

async function deleteRoutine(id: number): Promise<void> {
  if (!window.confirm('Delete this routine?')) return;
  try {
    await api.deleteRoutine(id);
    toast('Routine deleted');
    await loadRoutines();
  } catch (error) {
    toast(messageOf(error), 'err');
  }
}

function useExercise(name: string, reps: number): void {
  $<HTMLSelectElement>('ex').value = name;
  prefillFromHistory();
  $<HTMLInputElement>('reps').value = String(reps);
  $<HTMLInputElement>('reps').focus();
  $('set-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- Setup ---------- */

async function loadExercises(): Promise<void> {
  try {
    const exercises = await api.exercises();
    for (const e of exercises) {
      $<HTMLSelectElement>('ex').add(new Option(e.name));
      $<HTMLSelectElement>('rex').add(new Option(e.name));
    }
    prefillFromHistory();
  } catch (error) {
    $('set-err').textContent = `Couldn't load exercises: ${messageOf(error)}`;
  }
}

export function initLog(): void {
  $('log').innerHTML = TEMPLATE;

  $<HTMLFormElement>('set-form').addEventListener('submit', (e) => void onAddSet(e));
  $<HTMLFormElement>('set-form').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const step = target.closest<HTMLElement>('[data-step]');
    if (step) onStep(step);
  });
  $<HTMLSelectElement>('ex').addEventListener('change', prefillFromHistory);
  $('rpe-pills').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const pill = target.closest<HTMLElement>('[data-rpe]');
    if (!pill) return;
    const value = Number(pill.dataset.rpe);
    setRpe(rpe === value ? null : value);
  });
  $('rest-skip').addEventListener('click', stopRest);

  $<HTMLFormElement>('routine-form').addEventListener('submit', (e) => void onSaveRoutine(e));
  $('add-ex').addEventListener('click', onAddDraft);
  $<HTMLInputElement>('rn').addEventListener('input', updateSaveState);

  $('draft').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest<HTMLElement>('[data-rm]');
    if (!btn) return;
    draft.splice(Number(btn.dataset.rm), 1);
    renderDraft();
  });

  $('routines').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const del = target.closest<HTMLElement>('[data-del]');
    if (del) {
      void deleteRoutine(Number(del.dataset.del));
      return;
    }
    const pick = target.closest<HTMLElement>('[data-ex]');
    if (pick) useExercise(pick.dataset.ex ?? '', Number(pick.dataset.reps));
  });

  renderStats();
  void loadExercises();
}

/** Reload history + routines (called every time the Log tab is shown). */
export async function refreshLog(): Promise<void> {
  $('hist').innerHTML = '<div class="skeleton"></div>'.repeat(3);
  await Promise.all([loadHistory(), loadRoutines()]);
}