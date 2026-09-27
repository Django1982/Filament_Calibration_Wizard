// CORS for the /api/v1/* surface. Phase 1-5 assumed same-origin (browser tab
// pointed straight at this server); phase 6 adds a client that is NOT
// same-origin (desktop app loading assets from tauri://, or a browser tab on
// a different host/port) — without CORS headers those cross-origin fetches
// are blocked by the browser before a response ever reaches app code.
//
// `Access-Control-Allow-Origin: *` is safe ONLY when a PERFECTFIT_API_TOKEN
// is actually configured: this API's only credential is then a bearer token
// the client attaches explicitly (Authorization header), never a cookie or
// other ambient credential a browser sends automatically — a malicious page
// on another origin can trigger a cross-origin request, but without the
// token it gets the same 401 any unauthenticated caller would.
//
// The README documents a **no-token** deployment as the default ("fine for
// a container only reachable on your own LAN/VPN"). In that config there is
// no credential gating requests at all — same-origin-only enforcement by
// the browser (via the ABSENCE of CORS headers) is the only thing standing
// between "anyone on the LAN can load this page" and "anyone on the LAN can
// script arbitrary reads/writes/deletes against it from an unrelated site
// the victim's browser happens to have open". So CORS is only enabled when
// apiToken is set; an unset token falls all the way back to pre-CORS
// same-origin-only behavior (no headers, OPTIONS unhandled/404), matching
// how this server behaved before phase 6.
import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOWED_METHODS = 'GET, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/** Sets CORS headers on every /api/v1/* response, preflight or real — but only when a token is configured (see module comment). No-op otherwise. */
export function applyCorsHeaders(res: ServerResponse, apiToken: string | undefined): void {
  if (!apiToken) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
}

/**
 * Answers an OPTIONS preflight directly, with no auth/route-matching — the
 * browser sends preflight requests without the Authorization header it's
 * asking permission to send, so requiring a token here would make every
 * cross-origin request fail before the real one is even attempted.
 *
 * Only handles the request when a token is configured (see module comment);
 * with no token this returns false and OPTIONS falls through to normal
 * routing (404, unchanged from pre-phase-6 behavior) rather than advertising
 * cross-origin support that would then go unenforced.
 *
 * Returns true when it handled the request (caller must not process it further).
 */
export function handlePreflight(req: IncomingMessage, res: ServerResponse, apiToken: string | undefined): boolean {
  if (req.method !== 'OPTIONS') return false;
  if (!apiToken) return false;
  res.writeHead(204);
  res.end();
  return true;
}
