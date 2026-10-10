import './style.css';
import { initLog, refreshLog } from './log';
import { initTheme } from './theme';
import { $ } from './ui';

type TabId = 'log' | 'form' | 'coach' | 'dash' | 'photos';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'log', label: 'Log' },
  { id: 'form', label: 'Form Check' },
  { id: 'coach', label: 'Coach' },
  { id: 'dash', label: 'Dashboard' },
  { id: 'photos', label: 'Photos' },
];

const nav = $('nav');
nav.innerHTML = TABS.map((t) => `<button type="button" data-t="${t.id}">${t.label}</button>`).join('');

function show(id: TabId): void {
  for (const t of TABS) $(t.id).classList.toggle('on', t.id === id);
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.t === id));
  if (id === 'log') void refreshLog();
}

nav.addEventListener('click', (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  const id = target.dataset.t as TabId | undefined;
  if (id) show(id);
});

initTheme($<HTMLButtonElement>('theme'));
initLog();
show('log');