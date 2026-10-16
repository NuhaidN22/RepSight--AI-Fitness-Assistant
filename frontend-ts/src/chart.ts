import { esc } from './ui';

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartOptions {
  id: string; // unique per chart: used for the SVG gradient id
  label: string; // spoken by screen readers
  unit?: string;
  min?: number;
  max?: number;
  decimals?: number;
}

// The SVG has a fixed internal coordinate system (a "viewBox"). CSS scales it to any width,
// so every number below is in these units, not pixels.
const W = 600;
const H = 230;
const PL = 46; // padding left (room for y-axis labels)
const PR = 14;
const PT = 14;
const PB = 28; // padding bottom (room for x-axis labels)
const IW = W - PL - PR; // inner plot width
const IH = H - PT - PB; // inner plot height

export function shortDate(label: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(label)) {
    return new Date(`${label.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  }
  return label;
}

/**
 * Draws a themeable line + area chart with a hover crosshair and tooltip.
 * Colours come from CSS variables, so switching light/dark updates it with no redraw.
 */
export function renderLineChart(host: HTMLElement, points: ChartPoint[], opts: ChartOptions): void {
  const n = points.length;
  if (n === 0) {
    host.innerHTML = '';
    return;
  }

  // 1) Value range, with 12% breathing room so the line never touches the edges.
  const values = points.map((p) => p.value);
  let lo = opts.min ?? Math.min(...values);
  let hi = opts.max ?? Math.max(...values);
  const pad = (hi - lo) * 0.12 || 1; // "|| 1" handles a flat line (hi === lo)
  if (opts.min === undefined) lo -= pad;
  if (opts.max === undefined) hi += pad;

  const unit = opts.unit ?? '';
  const decimals = opts.decimals ?? (hi - lo < 10 ? 1 : 0);
  const fmt = (v: number): string => v.toFixed(decimals);

  // 2) Scales: data value -> SVG coordinate. SVG's y axis points DOWN, hence the "1 -".
  const xAt = (i: number): number => (n === 1 ? PL + IW / 2 : PL + (i / (n - 1)) * IW);
  const yAt = (v: number): number => PT + (1 - (v - lo) / (hi - lo)) * IH;

  // 3) Static pieces: grid lines with labels, the line, the filled area, x labels.
  const grid = [0, 1, 2, 3, 4]
    .map((k) => {
      const v = lo + ((hi - lo) * k) / 4;
      const y = yAt(v);
      return `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}"/><text x="${PL - 8}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`;
    })
    .join('');

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)} ${yAt(p.value)}`).join(' ');
  const area = `${line} L${xAt(n - 1)} ${PT + IH} L${xAt(0)} ${PT + IH} Z`;

  const xLabels = [...new Set([0, Math.floor((n - 1) / 2), n - 1])]
    .map((i) => {
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return `<text x="${xAt(i)}" y="${H - 8}" text-anchor="${anchor}">${esc(shortDate(points[i]?.label ?? ''))}</text>`;
    })
    .join('');

  const last = points[n - 1];
  const gid = `g-${esc(opts.id)}`;
  host.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style="stop-color:var(--ac);stop-opacity:.35"/>
            <stop offset="100%" style="stop-color:var(--ac);stop-opacity:0"/>
          </linearGradient>
        </defs>
        ${grid}
        ${n > 1 ? `<path class="area" d="${area}" fill="url(#${gid})"/>` : ''}
        <path class="line" d="${line}"/>
        ${xLabels}
        <circle class="last-dot" cx="${xAt(n - 1)}" cy="${last ? yAt(last.value) : 0}" r="4.5"/>
        <line class="cross" y1="${PT}" y2="${PT + IH}" style="display:none"/>
        <circle class="hover-dot" r="5.5" style="display:none"/>
        <rect class="hit" x="${PL}" y="${PT}" width="${IW}" height="${IH}" fill="transparent"/>
      </svg>
      <div class="chart-tip" hidden></div>
    </div>`;

  // 4) Hover: turn the pointer's screen position back into SVG units, then pick the nearest point.
  const svg = host.querySelector<SVGSVGElement>('svg');
  const tip = host.querySelector<HTMLElement>('.chart-tip');
  const cross = host.querySelector<SVGLineElement>('.cross');
  const dot = host.querySelector<SVGCircleElement>('.hover-dot');
  const hit = host.querySelector<SVGRectElement>('.hit');
  if (!svg || !tip || !cross || !dot || !hit) return;

  const show = (clientX: number): void => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const vx = ((clientX - rect.left) / rect.width) * W; // screen px -> viewBox units
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((vx - PL) / IW) * (n - 1))));
    const p = points[i];
    if (!p) return;
    const x = xAt(i);
    const y = yAt(p.value);
    cross.setAttribute('x1', String(x));
    cross.setAttribute('x2', String(x));
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    cross.style.display = '';
    dot.style.display = '';
    tip.hidden = false;
    tip.textContent = `${shortDate(p.label)} · ${fmt(p.value)}${unit}`;
    tip.style.left = `${(x / W) * 100}%`; // percentages keep the tooltip glued to the point when the chart resizes
    tip.style.top = `${(y / H) * 100}%`;
  };
  const hide = (): void => {
    cross.style.display = 'none';
    dot.style.display = 'none';
    tip.hidden = true;
  };
  hit.addEventListener('pointermove', (ev) => show(ev.clientX));
  hit.addEventListener('pointerdown', (ev) => show(ev.clientX));
  hit.addEventListener('pointerleave', hide);
}
