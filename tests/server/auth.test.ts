import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServerHandle } from './testServer.ts';
import { tokensMatch } from '../../server/auth.ts';

let server: TestServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('auth disabled (no PERFECTFIT_API_TOKEN)', () => {
  it('allows requests without any Authorization header', async () => {
    server = await startTestServer();
    const res = await fetch(`${server.baseUrl}/api/v1/printers`);
    expect(res.status).toBe(200);
  });
});

describe('auth enabled (PERFECTFIT_API_TOKEN set)', () => {
  it('allows the health check without a token', async () => {
    server = await startTestServer('secret-token');
    const res = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it('rejects requests with no Authorization header', async () => {
    server = await startTestServer('secret-token');
    const res = await fetch(`${server.baseUrl}/api/v1/printers`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('rejects requests with the wrong token', async () => {
    server = await startTestServer('secret-token');
    const res = await fetch(`${server.baseUrl}/api/v1/printers`, {
      headers: { Authorization: 'Bearer wrong-token' }
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token shorter than the configured one without crashing', async () => {
    server = await startTestServer('a-fairly-long-secret-token');
    const res = await fetch(`${server.baseUrl}/api/v1/printers`, {
      headers: { Authorization: 'Bearer x' }
    });
    expect(res.status).toBe(401);

    // the process must survive the length-mismatch comparison
    const health = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(health.status).toBe(200);
  });

  it('accepts requests with the correct token', async () => {
    server = await startTestServer('secret-token');
    const res = await fetch(`${server.baseUrl}/api/v1/printers`, {
      headers: { Authorization: 'Bearer secret-token' }
    });
    expect(res.status).toBe(200);
  });
});

describe('tokensMatch', () => {
  it('is true only for exact matches', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
  });

  it('does not throw on length mismatch', () => {
    expect(() => tokensMatch('short', 'a-much-longer-token')).not.toThrow();
    expect(tokensMatch('short', 'a-much-longer-token')).toBe(false);
  });

  it('does not throw on empty input', () => {
    expect(() => tokensMatch('', 'token')).not.toThrow();
    expect(tokensMatch('', 'token')).toBe(false);
  });
});
