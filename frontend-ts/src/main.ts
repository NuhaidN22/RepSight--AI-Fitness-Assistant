import './style.css';
import { focusCoach, initCoach } from './coach';
import { initDashboard, refreshDashboard } from './dashboard';
import { initForm, stopForm } from './form';
import { initLog, refreshLog } from './log';
import { initPhotos, refreshPhotos } from './photos';
import { requireLogin } from './auth';
import { api } from './api';
import { initTheme } from './theme';
import { $ } from './ui';

type TabId = 'log' | 'form' | 'coach' | 'dash' | 'photos';

const TABS: ReadonlyArray<{ id: TabId; label: string; hint: string; icon: string }> = [
  { id: 'log', label: 'Log', hint: 'Sets, routines, body weight', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' },
  { id: 'form', label: 'Kinetiq', hint: 'Camera form check', icon: '<circle cx="12" cy="5" r="2.5"/><path d="M12 8v7m0 0-3 6m3-6 3 6M7 11l5-3 5 3"/>' },
  { id: 'coach', label: 'Sinew', hint: 'AI coach chat', icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>' },
  { id: 'dash', label: 'Dashboard', hint: 'Progress at a glance', icon: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/>' },
  { id: 'photos', label: 'Photos', hint: 'Before and after', icon: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>' },
];
const svg = (paths: string): string =>
  `<svg class="ni" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const nav = $('nav');

/* Sidebar: minimize it to an icon rail; it opens again while the pointer (or keyboard focus) is on it. */
const app = document.querySelector<HTMLElement>('.app');
const collapseBtn = $<HTMLButtonElement>('collapse');
function setCollapsed(on: boolean): void {
  app?.classList.toggle('collapsed', on);
  collapseBtn.setAttribute('aria-pressed', String(on));
  const label = on ? 'Pin sidebar open' : 'Minimize sidebar';
  collapseBtn.setAttribute('aria-label', label);
  collapseBtn.title = label;
  try {
    localStorage.setItem('sidebar', on ? 'min' : 'open');
  } catch {
    /* private mode: the choice just will not be remembered */
  }
}
collapseBtn.addEventListener('click', () => setCollapsed(!app?.classList.contains('collapsed')));
let startMin = false;
try {
  startMin = localStorage.getItem('sidebar') === 'min';
} catch {
  /* ignore */
}
setCollapsed(startMin);
nav.innerHTML = TABS.map((t) => `<button type="button" data-t="${t.id}" title="${t.label}">${svg(t.icon)}<span class="nt"><b>${t.label}</b><small>${t.hint}</small></span></button>`).join('');

function show(id: TabId): void {
  for (const t of TABS) $(t.id).classList.toggle('on', t.id === id);
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.t === id));
  if (id !== 'form') stopForm(); // never leave the camera running in the background
  if (id === 'log') void refreshLog();
  if (id === 'dash') void refreshDashboard();
  if (id === 'photos') void refreshPhotos();
  if (id === 'coach') focusCoach();
}

nav.addEventListener('click', (ev) => {
  // The button holds an icon and two text lines, so the click usually lands on one of those, not on the button itself.
  const button = ev.target instanceof Element ? ev.target.closest<HTMLElement>('button[data-t]') : null;
  const id = button?.dataset.t as TabId | undefined;
  if (id) show(id);
});

initTheme($<HTMLButtonElement>('theme'));

// Nothing is loaded until the user is signed in; if the session ends later, go back to the login form.
window.addEventListener('auth-required', () => location.reload());
$('logout').addEventListener('click', () => {
  void api.logout().finally(() => location.reload());
});
void requireLogin().then((username) => {
  $('who').textContent = username;
  initLog();
  initForm();
  initCoach();
  initDashboard();
  initPhotos();
  show('log');
});
