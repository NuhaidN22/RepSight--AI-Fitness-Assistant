import { api } from './api';
import { renderLineChart, shortDate } from './chart';
import type { ChartPoint } from './chart';
import { ICONS } from './icons';
import type { DashboardData, PrEntry } from './types';
import { $, confirmDialog, copyText, esc, goTab, messageOf, setBusy, toast } from './ui';

const KPI_SKELETON = '<div class="kpi skeleton"></div>'.repeat(4);

const TEMPLATE = `
  <div class="page-head">
    <h2>Dashboard</h2>
    <p class="mut">Your training volume, personal records and body trends in one place.</p>
  </div>

  <div class="kpis" id="kpis">${KPI_SKELETON}</div>

  <div class="dash-grid">
    <div class="card">
      <div class="card-head"><h3>Body weight</h3><span class="pill" id="w-pill">—</span></div>
      <div id="chart-weight"></div>
      <p class="mut small" id="w-sub"></p>
    </div>
    <div class="card">
      <div class="card-head"><h3>Form score</h3><span class="pill" id="f-pill">—</span></div>
      <div id="chart-form"></div>
      <p class="mut small" id="f-sub"></p>
    </div>
  </div>

  <div class="dash-grid">
    <div class="card">
      <div class="card-head"><h3>Log body metrics</h3></div>
      <form id="metrics-form" novalidate>
        <div class="fields">
          <label class="field"><span>Weight (kg)</span>
            <input id="bw" type="number" step="0.1" min="20" max="400" inputmode="decimal" placeholder="e.g. 72.5"></label>
          <label class="field"><span>Height (cm) <small class="mut">optional</small></span>
            <input id="bh" type="number" min="80" max="260" inputmode="numeric" placeholder="e.g. 175"></label>
        </div>
        <p id="m-err" class="err" role="alert"></p>
        <button class="btn-primary" id="m-save" type="submit">Save metrics</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h3>Personal records</h3></div>
      <div id="prs"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3>Weekly AI summary</h3>
      <button class="btn-soft" id="sum-btn" type="button">${ICONS.spark} Generate</button>
    </div>
    <div id="sum-out" class="summary mut">Get a plain-language recap of your week: what went well and what to work on next.</div>
    <div class="row" id="sum-tools" hidden><button class="btn-ghost" id="sum-copy" type="button">Copy summary</button></div>
  </div>

  <div class="card danger-zone">
    <div class="card-head"><h3>Your data</h3></div>
    <p class="mut">Remove everything you have saved in this app. This cannot be undone.</p>
    <button class="btn-danger" id="wipe" type="button">${ICONS.trash} Delete all my data</button>
  </div>
`;

const fmt = (n: number): string => Math.round(n).toLocaleString();

function bmiCategory(bmi: number): string {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

function kpi(icon: string, label: string, value: string, sub: string, cls = ''): string {
  return `<div class="kpi ${cls}"><div class="kpi-ic">${icon}</div><span class="kpi-label">${label}</span><b class="kpi-val">${value}</b><span class="kpi-sub">${sub}</span></div>`;
}

function renderKpis(d: DashboardData): void {
  const top = d.prs.reduce<PrEntry | null>((best, p) => (!best || p.weight > best.weight ? p : best), null);
  const bmi = typeof d.bmi === 'number' ? d.bmi : null;
  const hasTrend = d.weight.length >= 2;

  $('kpis').innerHTML =
    kpi(ICONS.dumbbell, 'Weekly volume', `${fmt(d.weekly_volume)}<small> kg</small>`, 'Total lifted this week', 'hero') +
    kpi(
      ICONS.trophy,
      'Personal records',
      String(d.prs.length),
      top ? `Top: ${esc(top.exercise)} ${esc(top.weight)} kg` : 'Log sets to set records',
    ) +
    kpi(
      ICONS.scale,
      'BMI',
      bmi !== null ? bmi.toFixed(1) : '—',
      bmi !== null ? `${bmiCategory(bmi)} · rough guide` : 'Add weight and height',
    ) +
    kpi(
      ICONS.trend,
      'Weight trend',
      !hasTrend ? '—' : d.plateau ? 'Plateau' : 'No plateau',
      !hasTrend ? 'Needs two weight entries' : d.plateau ? 'Your weight has stopped changing' : 'Nothing flagged',
      d.plateau ? 'warn' : '',
    );
}

function deltaText(points: ChartPoint[], unit: string): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return 'Add more entries to see a trend.';
  const diff = last.value - first.value;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return `${sign}${Math.abs(diff).toFixed(1)}${unit} since ${shortDate(first.label)}`;
}

function drawChart(key: 'weight' | 'form', points: ChartPoint[], unit: string, emptyHtml: string, min?: number, max?: number): void {
  const host = $(`chart-${key}`);
  const pill = $(`${key === 'weight' ? 'w' : 'f'}-pill`);
  const sub = $(`${key === 'weight' ? 'w' : 'f'}-sub`);
  const last = points[points.length - 1];

  if (!last) {
    host.innerHTML = `<div class="empty-state small">${ICONS.chart}${emptyHtml}</div>`;
    pill.textContent = '—';
    sub.textContent = '';
    return;
  }
  renderLineChart(host, points, { id: key, label: key === 'weight' ? 'Body weight over time' : 'Form score over time', unit, min, max });
  pill.textContent = `${last.value.toFixed(1)}${unit}`;
  sub.textContent = deltaText(points, unit);
}

function renderPrs(d: DashboardData): void {
  const prs = [...d.prs].sort((a, b) => b.weight - a.weight);
  $('prs').innerHTML = prs.length
    ? prs
        .map((p) => `<div class="pr">${ICONS.trophy}<span class="pr-name">${esc(p.exercise)}</span><b>${esc(p.weight)} kg</b></div>`)
        .join('')
    : `<div class="empty-state small">${ICONS.trophy}<p><b>No records yet</b></p><p class="mut">Log some sets and your best lifts show up here.</p><button class="btn-soft" type="button" data-go="log">Log a set</button></div>`;
}

function renderAll(d: DashboardData): void {
  renderKpis(d);
  drawChart(
    'weight',
    d.weight.map((r) => ({ label: r.date, value: r.weight })),
    ' kg',
    '<p><b>No weight entries yet</b></p><p class="mut">Save your weight on the left to start a trend.</p>',
  );
  drawChart(
    'form',
    d.form.map((r) => ({ label: r.date, value: r.score })),
    '/100',
    '<p><b>No form checks yet</b></p><button class="btn-soft" type="button" data-go="form">Open Kinetiq</button>',
    0,
    100,
  );
  renderPrs(d);
}

export async function refreshDashboard(): Promise<void> {
  $('kpis').innerHTML = KPI_SKELETON;
  try {
    renderAll(await api.dashboard());
  } catch (error) {
    $('kpis').innerHTML = `<div class="card kpi-error"><p class="err">${esc(messageOf(error))}</p><button class="btn-soft" type="button" id="dash-retry">Retry</button></div>`;
  }
}

/* ---------- Actions ---------- */

async function saveMetrics(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const weight = Number($<HTMLInputElement>('bw').value);
  const heightRaw = $<HTMLInputElement>('bh').value;
  const height = heightRaw === '' ? null : Number(heightRaw);
  const errorBox = $('m-err');

  if (!Number.isFinite(weight) || weight < 20 || weight > 400) {
    errorBox.textContent = 'Enter a weight between 20 and 400 kg.';
    return;
  }
  if (height !== null && (!Number.isFinite(height) || height < 80 || height > 260)) {
    errorBox.textContent = 'Height must be between 80 and 260 cm (or leave it empty).';
    return;
  }
  errorBox.textContent = '';

  const button = $<HTMLButtonElement>('m-save');
  setBusy(button, true, 'Saving…');
  try {
    await api.addMetrics(weight, height);
    toast('Metrics saved');
    $<HTMLInputElement>('bw').value = '';
    await refreshDashboard();
  } catch (error) {
    toast(messageOf(error), 'err');
  } finally {
    setBusy(button, false, 'Save metrics');
  }
}

async function generateSummary(): Promise<void> {
  const out = $('sum-out');
  const button = $<HTMLButtonElement>('sum-btn');
  button.disabled = true;
  $('sum-tools').hidden = true;
  out.className = 'summary';
  out.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>';
  try {
    const { summary } = await api.summary();
    out.textContent = summary; // textContent: AI text is never parsed as HTML
    $('sum-tools').hidden = false;
    button.innerHTML = `${ICONS.spark} Regenerate`;
  } catch (error) {
    out.className = 'summary err';
    out.textContent = `Couldn't generate the summary: ${messageOf(error)}`;
  } finally {
    button.disabled = false;
  }
}

async function wipeData(): Promise<void> {
  const sure = await confirmDialog({
    title: 'Delete all your data?',
    message: 'Everything you have saved in this app will be removed permanently.',
    confirmLabel: 'Delete everything',
  });
  if (!sure) return;
  try {
    await api.deleteAllData();
    toast('All data deleted');
    await refreshDashboard();
  } catch (error) {
    toast(messageOf(error), 'err');
  }
}

export function initDashboard(): void {
  $('dash').innerHTML = TEMPLATE;

  $<HTMLFormElement>('metrics-form').addEventListener('submit', (e) => void saveMetrics(e));
  $('sum-btn').addEventListener('click', () => void generateSummary());
  $('sum-copy').addEventListener('click', () => void copyText($('sum-out').textContent ?? ''));
  $('wipe').addEventListener('click', () => void wipeData());

  // One delegated listener handles every "go to another tab" button and the retry button.
  $('dash').addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const go = target.closest<HTMLElement>('[data-go]');
    if (go?.dataset.go) goTab(go.dataset.go);
    if (target.closest('#dash-retry')) void refreshDashboard();
  });
}
