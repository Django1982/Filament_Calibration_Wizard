import { h, clear } from './ui/dom';
import { loadSettings, saveSettings } from './storage/store';
import { renderDashboard } from './ui/dashboard';
import { renderPrinters } from './ui/printers';
import { renderNewProject } from './ui/projectNew';
import { renderProject } from './ui/projectView';
import { renderWizard } from './ui/wizard';
import { renderHelp } from './ui/help';
import { renderSettings } from './ui/settings';
import { renderCard } from './ui/card';
import { renderReport } from './ui/report';
import { renderProfileWizard } from './ui/profileWizard';
import { renderAutomated } from './ui/automatedCalibration';
import { isDesktop, openExternalUrl } from './slicerIntegration/bridge';
import { toast } from './ui/dom';
import type { CalibrationId } from './types';

export type Route =
  | { view: 'dashboard' }
  | { view: 'printers' }
  | { view: 'new-project' }
  | { view: 'project'; id: string }
  | { view: 'wizard'; id: string; step: CalibrationId; origin?: 'automated' }
  | { view: 'card'; id: string }
  | { view: 'report'; id: string }
  | { view: 'profile'; id: string }
  | { view: 'automated'; id: string }
  | { view: 'help'; term?: string }
  | { view: 'settings' };

let outlet: HTMLElement;

/** Guard invoked before navigating away; set by wizard forms with unsaved work. */
let leaveGuard: (() => Promise<boolean>) | null = null;
export function setLeaveGuard(fn: (() => Promise<boolean>) | null): void { leaveGuard = fn; }

function prefersDarkScheme(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(): void {
  const s = loadSettings();
  const theme = s.theme === 'auto' ? (prefersDarkScheme() ? 'dark' : 'light') : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.largeText = String(s.largeText);
}

function onPreferredColorSchemeChange(fn: () => void): void {
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', fn);
  } else if (typeof query.addListener === 'function') {
    query.addListener(fn);
  }
}

export function navigate(hash: string): void {
  if (location.hash === hash) { void route(); return; }
  location.hash = hash;
}

export function parseHash(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'printers': return { view: 'printers' };
    case 'new': return { view: 'new-project' };
    case 'project': return parts[1] ? { view: 'project', id: parts[1] } : { view: 'dashboard' };
    case 'wizard': return parts[1] && parts[2]
      ? { view: 'wizard', id: parts[1], step: parts[2] as CalibrationId, origin: parts[3] === 'automated' ? 'automated' : undefined }
      : { view: 'dashboard' };
    case 'card': return parts[1] ? { view: 'card', id: parts[1] } : { view: 'dashboard' };
    case 'report': return parts[1] ? { view: 'report', id: parts[1] } : { view: 'dashboard' };
    case 'profile': return parts[1] ? { view: 'profile', id: parts[1] } : { view: 'dashboard' };
    case 'automated': return parts[1] ? { view: 'automated', id: parts[1] } : { view: 'dashboard' };
    case 'help': return { view: 'help', term: parts[1] };
    case 'settings': return { view: 'settings' };
    default: return { view: 'dashboard' };
  }
}

async function route(): Promise<void> {
  const r = parseHash();
  updateNav(r);
  clear(outlet);
  try {
    switch (r.view) {
      case 'dashboard': await renderDashboard(outlet); break;
      case 'printers': await renderPrinters(outlet); break;
      case 'new-project': await renderNewProject(outlet); break;
      case 'project': await renderProject(outlet, r.id); break;
      case 'wizard': await renderWizard(outlet, r.id, r.step, r.origin); break;
      case 'card': await renderCard(outlet, r.id); break;
      case 'report': await renderReport(outlet, r.id); break;
      case 'profile': await renderProfileWizard(outlet, r.id); break;
      case 'automated': await renderAutomated(outlet, r.id); break;
      case 'help': renderHelp(outlet, r.term); break;
      case 'settings': renderSettings(outlet); break;
    }
  } catch (err) {
    clear(outlet);
    outlet.append(
      h('div', { class: 'card' },
        h('h1', {}, 'Something went wrong'),
        h('p', {}, 'This view failed to load. Your data is stored locally and is not affected.'),
        h('p', { class: 'field-help' }, String(err)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-primary', onClick: () => navigate('#/') }, 'Back to dashboard'))
      )
    );
  }
  window.scrollTo(0, 0);
}

function navLink(href: string, label: string): HTMLElement {
  return h('a', { href }, label);
}

let navEl: HTMLElement;

function updateNav(r: Route): void {
  navEl.querySelectorAll('a').forEach(a => {
    const target = a.getAttribute('href') ?? '';
    const active =
      (target === '#/' && r.view === 'dashboard') ||
      (target === '#/printers' && r.view === 'printers') ||
      (target === '#/help' && r.view === 'help') ||
      (target === '#/settings' && r.view === 'settings');
    a.classList.toggle('active', active);
  });
}

/**
 * In the desktop (Tauri) app, `target="_blank"` anchors silently do nothing —
 * the webview has nowhere to open a new tab. Intercept clicks on external
 * http(s) links and hand them to the OS default browser via the native command.
 * In the browser build this handler is inert, so normal `_blank` behavior stays.
 */
function installExternalLinkHandler(): void {
  if (!isDesktop()) return;
  document.addEventListener('click', (e) => {
    // Left-click only; modifier keys have no useful default in the webview, so
    // we still handle them rather than letting them do nothing.
    if (e.defaultPrevented || e.button !== 0) return;
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !/^https?:\/\//i.test(href)) return; // in-app #/ routes fall through
    e.preventDefault();
    openExternalUrl(href).catch(() => toast('Could not open the link in your browser.', 'error'));
  });
}

export function startApp(): void {
  applyTheme();
  onPreferredColorSchemeChange(applyTheme);
  installExternalLinkHandler();

  const root = document.getElementById('app')!;
  clear(root);
  navEl = h('nav', { class: 'app-nav', 'aria-label': 'Main navigation' },
    navLink('#/', 'Projects'),
    navLink('#/printers', 'Printers'),
    navLink('#/help', 'Help & Glossary'),
    navLink('#/settings', 'Settings')
  );

  const themeBtn = h('button', {
    class: 'btn btn-ghost btn-sm', title: 'Toggle light/dark theme', 'aria-label': 'Toggle light/dark theme',
    onClick: () => {
      const s = loadSettings();
      const current = s.theme === 'auto' ? (prefersDarkScheme() ? 'dark' : 'light') : s.theme;
      s.theme = current === 'dark' ? 'light' : 'dark';
      saveSettings(s);
      applyTheme();
    }
  }, '🌓');

  root.append(
    h('header', { class: 'app-header' },
      h('div', { class: 'app-header-inner' },
        h('a', { class: 'app-logo', href: '#/' }, h('span', { 'aria-hidden': 'true' }, '🧵'), 'PerfectFit', h('span', { class: 'dot' }, '•'), h('span', { style: 'font-weight:500;color:var(--text-dim)' }, 'Filament Calibration')),
        navEl,
        h('div', { class: 'header-spacer' }),
        themeBtn
      )
    ),
    (outlet = h('main', { id: 'main' }))
  );

  window.addEventListener('hashchange', async (e) => {
    if (leaveGuard) {
      const ok = await leaveGuard();
      if (!ok) {
        // Revert the hash; replaceState doesn't fire hashchange, so the guard stays armed.
        const old = (e as HashChangeEvent).oldURL;
        const oldHash = old.includes('#') ? old.slice(old.indexOf('#')) : '#/';
        history.replaceState(null, '', oldHash);
        return;
      }
      leaveGuard = null;
    }
    void route();
  });

  void route();
}
