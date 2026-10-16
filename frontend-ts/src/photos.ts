import { api } from './api';
import { ICONS } from './icons';
import type { Photo } from './types';
import { $, confirmDialog, esc, messageOf, setBusy, toast } from './ui';

type Slot = 'b' | 'a';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 15 * 1024 * 1024; // a client-side guard so a huge file does not stall the upload
const TITLE: Record<Slot, string> = { b: 'Before', a: 'After' };

const slotTemplate = (slot: Slot): string => `
  <div class="card slot ${slot}">
    <div class="slot-head"><span class="badge ${slot}">${TITLE[slot].toUpperCase()}</span><span class="mut small" id="meta-${slot}"></span></div>
    <div class="drop" id="drop-${slot}" tabindex="0" role="button" aria-label="Choose ${TITLE[slot]} photo"><div class="prev2" id="prev-${slot}"></div></div>
    <input type="file" id="pf-${slot}" accept="image/jpeg,image/png,image/webp" hidden>
    <div class="slot-foot">
      <label class="field-inline"><span>Date taken</span><input type="date" id="pd-${slot}"></label>
      <button class="btn-primary" id="up-${slot}" type="button" disabled>Upload ${TITLE[slot]}</button>
    </div>
  </div>`;

const TEMPLATE = `
  <div class="page-head">
    <h2>Progress photos</h2>
    <p class="mut">Compare where you started with where you are now.</p>
  </div>

  <div class="note">${ICONS.shield}<span>Use the same pose, distance and lighting each time. This is a visual comparison only, with no body-fat estimates. Photos are sent to the AI model only when you press Analyze.</span></div>

  <div class="slots">${slotTemplate('b')}${slotTemplate('a')}</div>

  <div class="card" id="compare" hidden>
    <div class="card-head"><h3>Compare</h3><span class="pill" id="gap"></span></div>
    <div class="cmp" id="cmp" tabindex="0" role="slider" aria-label="Before and after comparison" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
      <img id="cmp-after" alt="After photo">
      <img id="cmp-before" alt="Before photo">
      <span class="cmp-label l">BEFORE</span><span class="cmp-label r">AFTER</span>
      <div class="cmp-handle" id="cmp-handle"><i></i></div>
    </div>
    <div class="row cmp-actions">
      <button class="btn-primary" id="analyze" type="button">${ICONS.spark} Analyze progress with AI</button>
      <button class="btn-soft" id="swap" type="button">${ICONS.swap} Swap</button>
      <button class="btn-ghost" id="reset" type="button">Start over</button>
    </div>
    <div class="analysis" id="pa" hidden></div>
  </div>

  <div class="card">
    <div class="card-head"><h3>Timeline <span class="pill" id="tlc">0</span></h3><button class="link" id="clear-all" type="button">Clear all</button></div>
    <p class="mut hint">Sorted by date. Tap Before or After on a photo to choose the two to compare.</p>
    <div class="tl2" id="tl"></div>
  </div>
`;

/* ---------- State ---------- */

let photos: Photo[] = [];
let selB: number | null = null;
let selA: number | null = null;
let sliderPos = 50;
const pendingFile: Record<Slot, File | null> = { b: null, a: null };
const pendingUrl: Record<Slot, string | null> = { b: null, a: null };

const today = (): string => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the user's own timezone
const selected = (slot: Slot): number | null => (slot === 'b' ? selB : selA);

/* ---------- Upload slots ---------- */

function renderSlot(slot: Slot): void {
  const prev = $(`prev-${slot}`);
  const url = pendingUrl[slot];
  const saved = photos.find((p) => p.id === selected(slot));

  if (url) {
    prev.innerHTML = `<img src="${esc(url)}" alt=""><span class="tag">Not uploaded yet</span>`;
  } else if (saved) {
    prev.innerHTML = `<img src="${esc(saved.path)}" alt=""><span class="tag ok">Saved · ${esc(saved.date)}</span>`;
  } else {
    prev.innerHTML = `<div class="drop-hint">${ICONS.image}<b>Click or drop a photo</b><span>JPG, PNG or WebP</span></div>`;
  }
  $<HTMLButtonElement>(`up-${slot}`).disabled = pendingFile[slot] === null;
}

function setPending(slot: Slot, file: File | null): void {
  const old = pendingUrl[slot];
  if (old) URL.revokeObjectURL(old); // free the memory held by the previous preview
  pendingFile[slot] = file;
  pendingUrl[slot] = file ? URL.createObjectURL(file) : null;
  renderSlot(slot);
}

function acceptFile(slot: Slot, file: File): void {
  if (!ALLOWED.includes(file.type)) {
    toast('Please choose a JPG, PNG or WebP image.', 'err');
    return;
  }
  if (file.size > MAX_BYTES) {
    toast('That photo is too large (15 MB max).', 'err');
    return;
  }
  setPending(slot, file);
}

async function upload(slot: Slot): Promise<void> {
  const file = pendingFile[slot];
  if (!file) return;
  const button = $<HTMLButtonElement>(`up-${slot}`);
  setBusy(button, true, 'Uploading…');
  try {
    const result = await api.uploadPhoto(file, $<HTMLInputElement>(`pd-${slot}`).value || today());
    if (typeof result.id === 'number') {
      if (slot === 'b') selB = result.id;
      else selA = result.id;
    }
    setPending(slot, null);
    $<HTMLInputElement>(`pf-${slot}`).value = '';
    toast(`${TITLE[slot]} photo saved`);
    await refreshPhotos();
  } catch (error) {
    toast(messageOf(error), 'err');
  } finally {
    setBusy(button, false, `Upload ${TITLE[slot]}`);
    renderSlot(slot); // re-applies the correct disabled state
  }
}

/* ---------- Compare slider ---------- */

function setSlider(pos: number): void {
  sliderPos = Math.max(0, Math.min(100, pos));
  $('cmp-before').style.clipPath = `inset(0 ${100 - sliderPos}% 0 0)`; // show only the left part of the BEFORE photo
  $('cmp-handle').style.left = `${sliderPos}%`;
  $('cmp').setAttribute('aria-valuenow', String(Math.round(sliderPos)));
}

function renderCompare(): void {
  const before = photos.find((p) => p.id === selB);
  const after = photos.find((p) => p.id === selA);
  if (!before || !after || before.id === after.id) {
    $('compare').hidden = true;
    return;
  }
  $('compare').hidden = false;
  $<HTMLImageElement>('cmp-before').src = before.path;
  $<HTMLImageElement>('cmp-after').src = after.path;
  const days = Math.round((new Date(after.date).getTime() - new Date(before.date).getTime()) / 864e5);
  $('gap').textContent = `${before.date} → ${after.date} · ${days} day${Math.abs(days) === 1 ? '' : 's'}`;
  setSlider(sliderPos);
}

/* ---------- Timeline ---------- */

function renderTimeline(): void {
  $('tlc').textContent = String(photos.length);
  $('tl').innerHTML = photos.length
    ? photos
        .map((p) => {
          const isB = p.id === selB;
          const isA = p.id === selA;
          return `<div class="tp2${isB ? ' b' : ''}${isA ? ' a' : ''}">
            <img src="${esc(p.path)}" alt="Photo from ${esc(p.date)}" loading="lazy">
            <div class="tp2-date">${esc(p.date)}</div>
            <div class="tp2-actions">
              <button type="button" class="chip-btn${isB ? ' on-b' : ''}" data-pick="b" data-id="${p.id}">Before</button>
              <button type="button" class="chip-btn${isA ? ' on-a' : ''}" data-pick="a" data-id="${p.id}">After</button>
              <button type="button" class="link" data-del="${p.id}">delete</button>
            </div>
          </div>`;
        })
        .join('')
    : `<div class="empty-state small">${ICONS.image}<p><b>No photos yet</b></p><p class="mut">Upload your Before and After above.</p></div>`;
}

function renderAll(): void {
  renderSlot('b');
  renderSlot('a');
  renderTimeline();
  renderCompare();
}

export async function refreshPhotos(): Promise<void> {
  $('tl').innerHTML = '<div class="skeleton tall"></div>';
  try {
    photos = await api.photos();
    photos.sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);
    if (!photos.some((p) => p.id === selB)) selB = null; // a selected photo may have been deleted elsewhere
    if (!photos.some((p) => p.id === selA)) selA = null;
    for (const slot of ['b', 'a'] as const) {
      const input = $<HTMLInputElement>(`pd-${slot}`);
      if (!input.value) input.value = today();
    }
    renderAll();
  } catch (error) {
    $('tl').innerHTML = `<p class="err">${esc(messageOf(error))}</p>`;
  }
}

/* ---------- Actions ---------- */

function choose(id: number, slot: Slot): void {
  if (slot === 'b') selB = id;
  else selA = id;
  $('pa').hidden = true;
  renderAll();
}

async function deletePhoto(id: number): Promise<void> {
  const sure = await confirmDialog({ title: 'Delete this photo?', message: 'It will be removed permanently.' });
  if (!sure) return;
  try {
    await api.deletePhoto(id);
    toast('Photo deleted');
    await refreshPhotos();
  } catch (error) {
    toast(messageOf(error), 'err');
  }
}

async function clearAll(): Promise<void> {
  if (photos.length === 0) return;
  const sure = await confirmDialog({
    title: 'Delete ALL progress photos?',
    message: `All ${photos.length} photos will be removed permanently.`,
    confirmLabel: 'Delete all',
  });
  if (!sure) return;
  try {
    await api.deleteAllPhotos();
    selB = null;
    selA = null;
    $('pa').hidden = true;
    toast('All photos deleted');
    await refreshPhotos();
  } catch (error) {
    toast(messageOf(error), 'err');
  }
}

async function analyze(): Promise<void> {
  if (selB === null || selA === null || selB === selA) {
    toast('Pick a Before and a different After photo.', 'err');
    return;
  }
  const button = $<HTMLButtonElement>('analyze');
  const out = $('pa');
  button.disabled = true;
  out.hidden = false;
  out.className = 'analysis';
  out.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>';
  try {
    const result = await api.analyzePhotos(selB, selA);
    out.textContent = result.caption ?? result.detail ?? 'No result'; // textContent: AI text is never parsed as HTML
  } catch (error) {
    out.className = 'analysis err';
    out.textContent = `Couldn't analyze: ${messageOf(error)}`;
  } finally {
    button.disabled = false;
  }
}

/* ---------- Setup ---------- */

export function initPhotos(): void {
  $('photos').innerHTML = TEMPLATE;

  for (const slot of ['b', 'a'] as const) {
    const drop = $(`drop-${slot}`);
    const input = $<HTMLInputElement>(`pf-${slot}`);
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) acceptFile(slot, file);
    });
    drop.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault();
      drop.classList.remove('over');
      const file = ev.dataTransfer?.files[0];
      if (file) acceptFile(slot, file);
    });
    $(`up-${slot}`).addEventListener('click', () => void upload(slot));
  }

  $('tl').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const pick = target.closest<HTMLElement>('[data-pick]');
    if (pick) {
      choose(Number(pick.dataset.id), pick.dataset.pick === 'b' ? 'b' : 'a');
      return;
    }
    const del = target.closest<HTMLElement>('[data-del]');
    if (del) void deletePhoto(Number(del.dataset.del));
  });
  $('clear-all').addEventListener('click', () => void clearAll());
  $('analyze').addEventListener('click', () => void analyze());
  $('swap').addEventListener('click', () => {
    [selB, selA] = [selA, selB];
    $('pa').hidden = true;
    renderAll();
  });
  $('reset').addEventListener('click', () => {
    selB = null;
    selA = null;
    $('pa').hidden = true;
    renderAll();
  });

  // Draggable comparison divider. setPointerCapture keeps the drag alive even if the pointer leaves the box.
  const cmp = $('cmp');
  const move = (clientX: number): void => {
    const rect = cmp.getBoundingClientRect();
    if (rect.width > 0) setSlider(((clientX - rect.left) / rect.width) * 100);
  };
  let dragging = false;
  cmp.addEventListener('pointerdown', (ev) => {
    dragging = true;
    cmp.setPointerCapture(ev.pointerId);
    move(ev.clientX);
  });
  cmp.addEventListener('pointermove', (ev) => {
    if (dragging) move(ev.clientX);
  });
  const stop = (): void => {
    dragging = false;
  };
  cmp.addEventListener('pointerup', stop);
  cmp.addEventListener('pointercancel', stop);
  cmp.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') setSlider(sliderPos - 3);
    if (ev.key === 'ArrowRight') setSlider(sliderPos + 3);
  });
}
