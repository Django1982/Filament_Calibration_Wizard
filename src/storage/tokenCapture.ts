// ---------------------------------------------------------------------------
// Pure logic for one-shot onboarding via URL query params: a self-hosted
// deployment can hand a user a link (e.g. from the container's admin, or a
// QR code for the desktop app) carrying their PERFECTFIT_API_TOKEN and/or
// the server's own URL. main.ts's bootstrap() captures these into
// localStorage and strips them from the URL immediately, so neither lingers
// in browser history, bookmarks, or gets leaked via a Referer header.
//
// Kept DOM/location-free so it's testable with plain URL strings — see
// eraseEverything.ts for the same "extract pure logic, test that" pattern.
// ---------------------------------------------------------------------------

export interface TokenCaptureResult {
  /** The captured token, or null if the URL carried no `token` query param. */
  token: string | null;
  /** `url` with the `token` param removed (query string dropped entirely if now empty). Unchanged when token is null. */
  strippedUrl: string;
}

export interface ServerUrlCaptureResult {
  /** The captured server URL, or null if the URL carried no `server` query param. */
  serverUrl: string | null;
  /** `url` with the `server` param removed (query string dropped entirely if now empty). Unchanged when serverUrl is null. */
  strippedUrl: string;
}

function captureParam(url: string, param: string): { value: string | null; strippedUrl: string } {
  const u = new URL(url);
  const value = u.searchParams.get(param);
  if (value === null) return { value: null, strippedUrl: url };

  u.searchParams.delete(param);
  const search = u.searchParams.toString();
  const strippedUrl = `${u.origin}${u.pathname}${search ? `?${search}` : ''}${u.hash}`;
  return { value, strippedUrl };
}

export function captureTokenFromUrl(url: string): TokenCaptureResult {
  const { value, strippedUrl } = captureParam(url, 'token');
  return { token: value, strippedUrl };
}

/** Same shape/behavior as captureTokenFromUrl, for a `?server=https://host:port` param — lets one link/QR code set both token and server URL for desktop onboarding. */
export function captureServerUrlFromUrl(url: string): ServerUrlCaptureResult {
  const { value, strippedUrl } = captureParam(url, 'server');
  return { serverUrl: value, strippedUrl };
}

/**
 * SECURITY: a bare `?server=` link must never be able to silently redirect
 * an ALREADY-stored token's Authorization header to a host of the link
 * author's choosing — that's a one-click token exfiltration (a stored token
 * from a legitimate earlier `?token=` onboarding gets sent, unattended, to
 * whatever host a since-received link names). So a URL-supplied server is
 * only trusted automatically when there is nothing yet to steal (no token
 * stored) or when the very same link is also supplying a fresh token — in
 * that case the old token is overwritten before the new server is ever
 * contacted, so it's never sent anywhere. Any other case (a stored token,
 * no fresh token in this link) must be rejected here; main.ts is expected
 * to drop the `?server=` value rather than persist it.
 */
export function shouldApplyServerUrlFromLink(opts: { hasStoredToken: boolean; hasFreshTokenInLink: boolean }): boolean {
  return !opts.hasStoredToken || opts.hasFreshTokenInLink;
}
