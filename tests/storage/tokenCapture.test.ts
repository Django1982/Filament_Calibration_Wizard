import { describe, expect, it } from 'vitest';
import { captureTokenFromUrl, captureServerUrlFromUrl, shouldApplyServerUrlFromLink } from '../../src/storage/tokenCapture';

describe('captureTokenFromUrl', () => {
  it('returns null token and the unchanged URL when there is no token param', () => {
    const result = captureTokenFromUrl('http://localhost:8090/#/dashboard');
    expect(result.token).toBeNull();
    expect(result.strippedUrl).toBe('http://localhost:8090/#/dashboard');
  });

  it('extracts a token param and strips it, dropping the now-empty query string', () => {
    const result = captureTokenFromUrl('http://localhost:8090/?token=test123');
    expect(result.token).toBe('test123');
    expect(result.strippedUrl).toBe('http://localhost:8090/');
  });

  it('preserves the hash fragment (hash-based router state) after stripping', () => {
    const result = captureTokenFromUrl('http://localhost:8090/?token=abc#/wizard/p1/temperature');
    expect(result.token).toBe('abc');
    expect(result.strippedUrl).toBe('http://localhost:8090/#/wizard/p1/temperature');
  });

  it('preserves other query params, removing only token', () => {
    const result = captureTokenFromUrl('http://localhost:8090/?foo=bar&token=abc&baz=1');
    expect(result.token).toBe('abc');
    expect(result.strippedUrl).toBe('http://localhost:8090/?foo=bar&baz=1');
  });

  it('preserves a non-root pathname', () => {
    const result = captureTokenFromUrl('http://localhost:8090/perfectfit/?token=abc');
    expect(result.token).toBe('abc');
    expect(result.strippedUrl).toBe('http://localhost:8090/perfectfit/');
  });

  it('still strips an empty `?token=` param even though the captured value is falsy', () => {
    // URLSearchParams.get('token') on `?token=` returns '' not null. This
    // function still reports/strips it (callers, e.g. main.ts, treat a
    // falsy token as "nothing to store" and skip setStoredToken).
    const result = captureTokenFromUrl('http://localhost:8090/?token=');
    expect(result.token).toBe('');
    expect(result.strippedUrl).toBe('http://localhost:8090/');
  });
});

describe('captureServerUrlFromUrl', () => {
  it('returns null serverUrl and the unchanged URL when there is no server param', () => {
    const result = captureServerUrlFromUrl('http://localhost:5173/#/dashboard');
    expect(result.serverUrl).toBeNull();
    expect(result.strippedUrl).toBe('http://localhost:5173/#/dashboard');
  });

  it('extracts a server param and strips it, dropping the now-empty query string', () => {
    const result = captureServerUrlFromUrl('http://localhost:5173/?server=http%3A%2F%2F192.168.1.50%3A8090');
    expect(result.serverUrl).toBe('http://192.168.1.50:8090');
    expect(result.strippedUrl).toBe('http://localhost:5173/');
  });

  it('preserves the hash fragment after stripping', () => {
    const result = captureServerUrlFromUrl('http://localhost:5173/?server=https%3A%2F%2Fexample.test#/wizard/p1/temperature');
    expect(result.serverUrl).toBe('https://example.test');
    expect(result.strippedUrl).toBe('http://localhost:5173/#/wizard/p1/temperature');
  });

  it('composes with captureTokenFromUrl so a single link can carry both params', () => {
    const original = 'http://localhost:5173/?token=abc&server=https%3A%2F%2Fexample.test&foo=bar';
    const tokenResult = captureTokenFromUrl(original);
    expect(tokenResult.token).toBe('abc');

    const serverResult = captureServerUrlFromUrl(tokenResult.strippedUrl);
    expect(serverResult.serverUrl).toBe('https://example.test');
    expect(serverResult.strippedUrl).toBe('http://localhost:5173/?foo=bar');
  });
});

// Regression coverage for the Cerberus-flagged finding: a bare ?server= link
// must never be able to silently redirect an already-stored token's
// Authorization header to an attacker-chosen host. See
// shouldApplyServerUrlFromLink()'s doc comment in tokenCapture.ts and
// main.ts's captureTokenFromLocation(), which is the only caller.
describe('shouldApplyServerUrlFromLink (security gate for ?server=)', () => {
  it('is false for a bare ?server= link when a token is already stored — the vulnerable case', () => {
    expect(shouldApplyServerUrlFromLink({ hasStoredToken: true, hasFreshTokenInLink: false })).toBe(false);
  });

  it('is true when no token is stored yet — nothing to steal, safe to apply a server-only link', () => {
    expect(shouldApplyServerUrlFromLink({ hasStoredToken: false, hasFreshTokenInLink: false })).toBe(true);
  });

  it('is true when the same link also supplies a fresh token — the old token is overwritten before the new server is ever contacted', () => {
    expect(shouldApplyServerUrlFromLink({ hasStoredToken: true, hasFreshTokenInLink: true })).toBe(true);
  });

  it('is true when no token was stored and this link also supplies one (ordinary first-time onboarding)', () => {
    expect(shouldApplyServerUrlFromLink({ hasStoredToken: false, hasFreshTokenInLink: true })).toBe(true);
  });
});

/**
 * End-to-end simulation of main.ts's captureTokenFromLocation() using only
 * the exported pure pieces (main.ts itself self-executes bootstrap() on
 * import and isn't importable in isolation — see its module-level `void
 * bootstrap();`). Mirrors the exact sequence main.ts runs: check the
 * pre-existing stored token, parse+apply ?token=, parse ?server=, gate it
 * through shouldApplyServerUrlFromLink, and only apply if allowed.
 */
function simulateCaptureFromLocation(url: string, hadStoredToken: boolean): { appliedServerUrl: string | null; appliedToken: string | null } {
  const tokenResult = captureTokenFromUrl(url);
  const appliedToken = tokenResult.token || null;

  const serverResult = captureServerUrlFromUrl(tokenResult.strippedUrl);
  const allowed = serverResult.serverUrl
    ? shouldApplyServerUrlFromLink({ hasStoredToken: hadStoredToken, hasFreshTokenInLink: Boolean(appliedToken) })
    : false;

  return { appliedServerUrl: allowed ? serverResult.serverUrl : null, appliedToken };
}

describe('captureTokenFromLocation flow simulation (main.ts logic, via exported pure pieces)', () => {
  it('does NOT apply a bare ?server= link when a token is already stored (the exploit link from the PoC)', () => {
    const result = simulateCaptureFromLocation('http://localhost:5173/?server=http%3A%2F%2Fattacker-host', true);
    expect(result.appliedServerUrl).toBeNull();
    expect(result.appliedToken).toBeNull();
  });

  it('applies a bare ?server= link when no token is stored yet', () => {
    const result = simulateCaptureFromLocation('http://localhost:5173/?server=http%3A%2F%2F192.168.1.50%3A8090', false);
    expect(result.appliedServerUrl).toBe('http://192.168.1.50:8090');
  });

  it('applies ?server= alongside a fresh ?token= even when a (now-overwritten) token was already stored', () => {
    const result = simulateCaptureFromLocation(
      'http://localhost:5173/?token=fresh-token&server=http%3A%2F%2F192.168.1.50%3A8090',
      true
    );
    expect(result.appliedToken).toBe('fresh-token');
    expect(result.appliedServerUrl).toBe('http://192.168.1.50:8090');
  });
});
