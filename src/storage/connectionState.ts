// ---------------------------------------------------------------------------
// Tracks which of four states the app is in with respect to the optional
// self-hosted server, beyond serverBridge.ts's plain reachable/unreachable
// signal:
//
//   'no-url'      — running somewhere a relative fetch can't reach a
//                   same-origin server (e.g. the Tauri desktop shell) and no
//                   server URL has been configured yet. Distinct from
//                   'no-backend' below so Settings can point the user at the
//                   URL field instead of implying "nothing to do here".
//   'no-backend'  — no server responds to the health check (today's default
//                   for same-origin browser users with no server; also
//                   covers a configured server URL that isn't reachable).
//   'connected'   — server reachable and a data call succeeded (either no
//                   token is configured server-side, or a stored token works).
//   'needs-token' — server reachable but a data call came back 401: a token
//                   is required and the one stored (if any) is missing/wrong.
//
// There is no dedicated "is auth enabled" endpoint (see server/auth.ts), so
// this is inferred empirically from the outcome of the settings hydration
// call store.ts already makes at startup. Exposed the same way
// serverBridge.ts exposes isBackendReadySync(): a memoized module-level
// value written by hydrateSettingsFromServer()/reconnect flows, read
// synchronously by UI that renders after bootstrap.
// ---------------------------------------------------------------------------

export type ConnectionState = 'no-url' | 'no-backend' | 'connected' | 'needs-token';

let state: ConnectionState = 'no-backend';

/** Synchronous read of the last-determined connection state. */
export function getConnectionState(): ConnectionState {
  return state;
}

export function setConnectionState(next: ConnectionState): void {
  state = next;
}

/**
 * Pure decision logic, extracted so the four-state outcome is testable
 * without touching fetch/localStorage. `healthOk` mirrors serverBridge's
 * backendReady(); `authFailed` should be true only when a data call came
 * back 401 specifically (not any other error, which leaves connectivity
 * ambiguous and is treated as 'connected' — the server IS reachable, the
 * failure is presumed transient/unrelated to auth).
 *
 * `isDesktop`/`hasServerUrl` default to false, so existing callers that only
 * pass healthOk/authFailed keep today's three-state behavior unchanged.
 * `no-url` is checked first and independent of `healthOk`: in practice a
 * relative fetch from a no-URL desktop client will already fail the health
 * check (hitting 'no-backend' anyway), but the explicit check doesn't rely
 * on that being true — it directly names the one case we can identify with
 * certainty ("this client structurally cannot use a relative path") rather
 * than inferring it from a fetch outcome that happens to also be false.
 */
export function deriveConnectionState(opts: {
  healthOk: boolean;
  authFailed: boolean;
  isDesktop?: boolean;
  hasServerUrl?: boolean;
}): ConnectionState {
  if (opts.isDesktop && !opts.hasServerUrl) return 'no-url';
  if (!opts.healthOk) return 'no-backend';
  return opts.authFailed ? 'needs-token' : 'connected';
}
