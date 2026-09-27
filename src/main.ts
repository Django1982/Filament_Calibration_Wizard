import './styles.css';
import { startApp } from './app';
import { hydrateSettingsFromServer } from './storage/store';
import { getStoredToken, setStoredToken, setStoredServerUrl } from './storage/serverBridge';
import { captureTokenFromUrl, captureServerUrlFromUrl, shouldApplyServerUrlFromLink } from './storage/tokenCapture';

/**
 * A self-hosted deployment can hand a user a one-time link carrying their
 * PERFECTFIT_API_TOKEN (`?token=...`) and/or the server's own URL
 * (`?server=...`, needed for clients that aren't same-origin with it — see
 * serverBridge.ts). Both are captured into localStorage and stripped from
 * the URL immediately (before hydrateSettingsFromServer() so they're used on
 * the very first backend call, not just saved for next time) so neither
 * lingers in history/bookmarks/Referer. A single link/QR code carrying both
 * params is enough for one-shot desktop onboarding.
 *
 * SECURITY: `?server=` is deliberately NOT applied unattended when a token
 * is already stored and this link doesn't also carry a fresh one — see
 * shouldApplyServerUrlFromLink()'s doc comment. Without this guard, a bare
 * `?server=https://attacker-host` link would silently repoint an existing
 * stored token's Authorization header at an attacker-chosen host.
 */
function captureTokenFromLocation(): void {
  let href = location.href;
  let changed = false;

  const hadStoredToken = getStoredToken() !== null;

  const tokenResult = captureTokenFromUrl(href);
  if (tokenResult.token) {
    setStoredToken(tokenResult.token);
    href = tokenResult.strippedUrl;
    changed = true;
  }

  const serverResult = captureServerUrlFromUrl(href);
  if (serverResult.serverUrl) {
    const allowed = shouldApplyServerUrlFromLink({
      hasStoredToken: hadStoredToken,
      hasFreshTokenInLink: Boolean(tokenResult.token)
    });
    if (allowed) {
      try {
        setStoredServerUrl(serverResult.serverUrl);
      } catch {
        // Malformed ?server= value — still drop it from the URL below, but
        // leave any existing/no stored server URL alone.
      }
    } else {
      console.warn('Ignored ?server= from a link: a token is already stored and this link did not supply a fresh one.');
    }
    href = serverResult.strippedUrl;
    changed = true;
  }

  if (changed) history.replaceState(null, '', href);
}

async function bootstrap(): Promise<void> {
  captureTokenFromLocation();

  // Must resolve before startApp()'s first synchronous loadSettings() call so
  // server-side settings (if any backend is configured) win over stale local
  // ones on load. No-op — resolves promptly — when no backend is reachable.
  await hydrateSettingsFromServer();

  try {
    startApp();
  } catch (err) {
    const root = document.getElementById('app');
    if (root) {
      const main = document.createElement('main');
      main.className = 'startup-error';
      main.setAttribute('style', 'padding:2rem;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');

      const title = document.createElement('h1');
      title.textContent = 'PerfectFit could not start';
      const body = document.createElement('p');
      body.textContent = 'The app window opened, but startup failed before the wizard could render.';
      const detail = document.createElement('pre');
      detail.setAttribute('style', 'white-space:pre-wrap;background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;padding:1rem');
      detail.textContent = String(err);

      main.append(title, body, detail);
      root.replaceChildren(main);
    }
    console.error('PerfectFit startup failed', err);
  }
}

void bootstrap();

// PWA service worker — for real web deployments only. Inside Tauri the app is
// served from disk, so a service worker adds nothing and a cache-first one is
// actively dangerous: after an update it keeps serving the previous version's
// index.html, whose hashed bundle no longer exists, wedging the app on the
// static loading screen. In Tauri we therefore unregister any worker left by
// an older version and drop its caches (user data in IndexedDB/localStorage is
// unaffected).
const isTauri = '__TAURI_INTERNALS__' in window || location.hostname === 'tauri.localhost';
if ('serviceWorker' in navigator) {
  if (isTauri) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => { r.unregister().catch(() => {}); }))
      .catch(() => {});
    if (typeof caches !== 'undefined') {
      caches.keys().then((keys) => keys.forEach((k) => { caches.delete(k).catch(() => {}); })).catch(() => {});
    }
  } else if (location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline install is optional */ });
    });
  }
}
