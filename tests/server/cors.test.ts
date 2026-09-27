// CORS headers for the /api/v1/* surface — see server/cors.ts for the
// wildcard-origin reasoning (bearer-token auth, no ambient credentials) and
// why it's gated on PERFECTFIT_API_TOKEN actually being configured.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServerHandle } from './testServer.ts';

let server: TestServerHandle;

afterEach(async () => {
  await server?.close();
});

describe('CORS preflight (OPTIONS) — token configured', () => {
  beforeEach(async () => {
    server = await startTestServer('secret-token');
  });

  it('answers an OPTIONS preflight on an API route with 204 and the expected CORS headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers`, { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('answers preflight without requiring auth (no Authorization header sent)', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers`, { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('does not dispatch to a route handler for OPTIONS (no body, no route side effects)', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers/some-id`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);

    // Confirm nothing was written as a side effect of the preflight.
    const getRes = await fetch(`${server.baseUrl}/api/v1/printers/some-id`, {
      headers: { Authorization: 'Bearer secret-token' }
    });
    expect(getRes.status).toBe(404);
  });
});

describe('CORS headers on real requests — token configured', () => {
  beforeEach(async () => {
    server = await startTestServer('secret-token');
  });

  it('sets Access-Control-Allow-Origin on a real GET response', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('sets CORS headers on a real authenticated PUT response', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ id: 'printer-1', name: 'Bench' })
    });
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('sets CORS headers even on an error response (e.g. 401 for a missing/wrong token)', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers`);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('does not set CORS headers on non-API (static) responses', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    // No dist/ directory in the test fixture, so this 404s — the point here
    // is purely that the static path isn't given CORS headers.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// Regression coverage for the Cerberus-flagged finding: wildcard CORS must
// NOT be sent for the documented no-token default (README: "fine for a
// container only reachable on your own LAN/VPN"). Without a token gating
// requests, permissive CORS headers would let ANY origin the victim's
// browser has open read/write/delete all data with ordinary cross-origin
// fetch() calls — live-PoC-verified before this fix.
describe('CORS is disabled entirely when no token is configured (fail closed)', () => {
  beforeEach(async () => {
    server = await startTestServer(); // no apiToken
  });

  it('sets no Access-Control-Allow-Origin header on a real GET response', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
  });

  it('sets no CORS headers on a real PUT/GET/DELETE round trip (cross-origin fetch would be blocked by the browser)', async () => {
    const putRes = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      method: 'PUT',
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify({ id: 'printer-1', name: 'Bench' })
    });
    expect([200, 204]).toContain(putRes.status);
    expect(putRes.headers.get('access-control-allow-origin')).toBeNull();

    const getRes = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      headers: { Origin: 'https://evil.example' }
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('access-control-allow-origin')).toBeNull();

    const deleteRes = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example' }
    });
    expect(deleteRes.status).toBe(204);
    expect(deleteRes.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not answer an OPTIONS preflight specially — falls through to normal (404) routing, matching pre-CORS behavior', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers`, { method: 'OPTIONS' });

    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
