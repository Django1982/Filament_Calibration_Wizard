import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServerHandle } from './testServer.ts';

const FIXTURE_STATIC_DIR = join(__dirname, 'fixtures', 'static');

let server: TestServerHandle;

beforeEach(async () => {
  server = await startTestServer(undefined, FIXTURE_STATIC_DIR);
});

afterEach(async () => {
  await server.close();
});

describe('static file serving', () => {
  it('serves an existing file with the right content-type', async () => {
    const res = await fetch(`${server.baseUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toContain('fixture asset');
  });

  it('serves index.html for the root path', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('fixture index');
  });

  it('falls back to index.html for an unmatched path (SPA fallback)', async () => {
    const res = await fetch(`${server.baseUrl}/wizard/some-project/step-1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('fixture index');
  });

  it('does not intercept /api/v1/* paths', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects path-traversal attempts', async () => {
    const res = await fetch(`${server.baseUrl}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(404);
  });

  it('rejects path-traversal attempts using literal dot segments', async () => {
    const res = await fetch(`${server.baseUrl}/../../../etc/passwd`);
    // The HTTP client/server layer normalizes '../' before it ever reaches
    // our handler, so this either 404s outright or falls back to index.html —
    // either way it must never escape the static root.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(await res.text()).toContain('fixture index');
    }
  });

  it('responds sanely to HEAD requests', async () => {
    const res = await fetch(`${server.baseUrl}/assets/app.js`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String('console.log(\'fixture asset\');\n'.length));
    expect(await res.text()).toBe('');
  });

  it('404s a method other than GET/HEAD on a non-API path', async () => {
    const res = await fetch(`${server.baseUrl}/assets/app.js`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
