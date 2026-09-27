// Regression tests for the two Cerberus-flagged findings on the server
// module: stored content-type injection on photo upload, and unbounded
// request body size on any PUT endpoint.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServerHandle } from './testServer.ts';

let server: TestServerHandle;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function photoUrl(baseUrl: string, id: string, type: string): string {
  return (
    `${baseUrl}/api/v1/photos/${id}?projectId=p&stepId=s&attemptId=a` +
    `&createdAt=${encodeURIComponent(new Date().toISOString())}&name=x&type=${encodeURIComponent(type)}`
  );
}

describe('photo content-type allowlist', () => {
  it('rejects a non-image type (stored content-type injection / XSS PoC) with 400', async () => {
    const res = await fetch(photoUrl(server.baseUrl, 'evil', 'text/html'), {
      method: 'PUT',
      body: '<script>alert(document.cookie)</script>'
    });
    expect(res.status).toBe(400);

    // Confirm nothing was written — the "poison pill" row this also used to leave behind is gone too.
    const getRes = await fetch(`${server.baseUrl}/api/v1/photos/evil`);
    expect(getRes.status).toBe(404);
  });

  it('rejects other non-image mime types too, e.g. application/javascript', async () => {
    const res = await fetch(photoUrl(server.baseUrl, 'evil2', 'application/javascript'), {
      method: 'PUT',
      body: 'alert(1)'
    });
    expect(res.status).toBe(400);
  });

  it('still accepts a real image type and serves it back with nosniff set', async () => {
    const putRes = await fetch(photoUrl(server.baseUrl, 'good', 'image/png'), {
      method: 'PUT',
      body: new Uint8Array([137, 80, 78, 71])
    });
    expect(putRes.status).toBe(204);

    const getRes = await fetch(`${server.baseUrl}/api/v1/photos/good`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/png');
    expect(getRes.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a previously-valid photo is unaffected by a rejected upload attempt on a different id', async () => {
    await fetch(photoUrl(server.baseUrl, 'existing', 'image/jpeg'), {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3])
    });

    const rejected = await fetch(photoUrl(server.baseUrl, 'attacker', 'text/html'), {
      method: 'PUT',
      body: '<script>1</script>'
    });
    expect(rejected.status).toBe(400);

    const stillGood = await fetch(`${server.baseUrl}/api/v1/photos/existing`);
    expect(stillGood.status).toBe(200);
    expect(stillGood.headers.get('content-type')).toBe('image/jpeg');
  });
});

describe('request body size limits', () => {
  it('rejects an oversized JSON body (printer PUT) with 413, not 500 or a hang', async () => {
    const oversized = JSON.stringify({ id: 'huge', notes: 'x'.repeat(2 * 1024 * 1024) });
    const res = await fetch(`${server.baseUrl}/api/v1/printers/huge`, { method: 'PUT', body: oversized });
    expect(res.status).toBe(413);

    // Nothing was written.
    expect((await fetch(`${server.baseUrl}/api/v1/printers/huge`)).status).toBe(404);
  });

  it('rejects an oversized project PUT body with 413', async () => {
    const oversized = JSON.stringify({ id: 'huge-project', notes: 'y'.repeat(2 * 1024 * 1024) });
    const res = await fetch(`${server.baseUrl}/api/v1/projects/huge-project`, { method: 'PUT', body: oversized });
    expect(res.status).toBe(413);
  });

  it('rejects an oversized photo upload with 413', async () => {
    const oversized = new Uint8Array(51 * 1024 * 1024); // over the 50MB photo cap
    const res = await fetch(photoUrl(server.baseUrl, 'too-big', 'image/png'), { method: 'PUT', body: oversized });
    expect(res.status).toBe(413);
  });

  it('the server keeps serving requests after an oversized-body rejection (no crash, connection stays usable)', async () => {
    const oversized = JSON.stringify({ id: 'huge2', notes: 'z'.repeat(2 * 1024 * 1024) });
    await fetch(`${server.baseUrl}/api/v1/printers/huge2`, { method: 'PUT', body: oversized });

    const health = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(health.status).toBe(200);

    const putRes = await fetch(`${server.baseUrl}/api/v1/printers/small`, {
      method: 'PUT',
      body: JSON.stringify({ id: 'small', name: 'ok' })
    });
    expect(putRes.status).toBe(204);
  });

  it('accepts a normal-sized JSON body under the cap', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers/normal`, {
      method: 'PUT',
      body: JSON.stringify({ id: 'normal', name: 'Bench Printer' })
    });
    expect(res.status).toBe(204);
  });
});
