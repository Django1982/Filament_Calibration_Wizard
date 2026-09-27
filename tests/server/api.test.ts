import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServerHandle } from './testServer.ts';

let server: TestServerHandle;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe('health', () => {
  it('responds ok', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('printers CRUD', () => {
  it('round-trips a printer through put/get/list/delete', async () => {
    const printer = { id: 'printer-1', name: 'Bench Printer', nozzleDiameter: 0.4 };

    const putRes = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      method: 'PUT',
      body: JSON.stringify(printer)
    });
    expect([200, 204]).toContain(putRes.status);

    const getRes = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(printer);

    const listRes = await fetch(`${server.baseUrl}/api/v1/printers`);
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([printer]);

    const deleteRes = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);

    const getAfterDelete = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`);
    expect(getAfterDelete.status).toBe(404);
  });

  it('deleting a printer twice is idempotent (still 204)', async () => {
    const res1 = await fetch(`${server.baseUrl}/api/v1/printers/never-existed`, { method: 'DELETE' });
    const res2 = await fetch(`${server.baseUrl}/api/v1/printers/never-existed`, { method: 'DELETE' });
    expect(res1.status).toBe(204);
    expect(res2.status).toBe(204);
  });

  it('404s a missing printer', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('400s a body id that mismatches the URL id', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      method: 'PUT',
      body: JSON.stringify({ id: 'printer-2', name: 'x' })
    });
    expect(res.status).toBe(400);
  });

  it('400s malformed JSON instead of crashing', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/printers/printer-1`, {
      method: 'PUT',
      body: '{not valid json'
    });
    expect(res.status).toBe(400);

    // the server must still be alive for the next request
    const health = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(health.status).toBe(200);
  });
});

describe('projects CRUD + cascade delete', () => {
  it('cascade-deletes photos when a project is deleted', async () => {
    const project = { id: 'proj-1', filament: { material: 'PLA' } };
    await fetch(`${server.baseUrl}/api/v1/projects/proj-1`, { method: 'PUT', body: JSON.stringify(project) });

    const photoBytes = new Uint8Array([1, 2, 3, 4]);
    const photoUrl =
      `${server.baseUrl}/api/v1/photos/photo-1?projectId=proj-1&stepId=step-1&attemptId=attempt-1` +
      `&createdAt=${encodeURIComponent(new Date().toISOString())}&name=${encodeURIComponent('a.png')}&type=image%2Fpng`;
    const putPhotoRes = await fetch(photoUrl, { method: 'PUT', body: photoBytes });
    expect(putPhotoRes.status).toBe(204);

    const photosBeforeDelete = await fetch(`${server.baseUrl}/api/v1/projects/proj-1/photos`);
    expect(await photosBeforeDelete.json()).toHaveLength(1);

    const deleteRes = await fetch(`${server.baseUrl}/api/v1/projects/proj-1`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);

    expect((await fetch(`${server.baseUrl}/api/v1/projects/proj-1`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/api/v1/photos/photo-1`)).status).toBe(404);
  });

  it('lists photo metadata without exposing the binary data field', async () => {
    const project = { id: 'proj-2' };
    await fetch(`${server.baseUrl}/api/v1/projects/proj-2`, { method: 'PUT', body: JSON.stringify(project) });

    const createdAt = new Date().toISOString();
    const photoUrl =
      `${server.baseUrl}/api/v1/photos/photo-2?projectId=proj-2&stepId=step-1&attemptId=attempt-1` +
      `&createdAt=${encodeURIComponent(createdAt)}&name=${encodeURIComponent('b.jpg')}&type=image%2Fjpeg`;
    await fetch(photoUrl, { method: 'PUT', body: new Uint8Array([9, 9]) });

    const res = await fetch(`${server.baseUrl}/api/v1/projects/proj-2/photos`);
    const photos = await res.json();
    expect(photos).toEqual([
      {
        id: 'photo-2',
        projectId: 'proj-2',
        stepId: 'step-1',
        attemptId: 'attempt-1',
        createdAt,
        name: 'b.jpg',
        type: 'image/jpeg'
      }
    ]);
  });
});

describe('photo binary round-trip', () => {
  it('preserves exact bytes and content-type', async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;

    const url =
      `${server.baseUrl}/api/v1/photos/photo-bin?projectId=p&stepId=s&attemptId=a` +
      `&createdAt=${encodeURIComponent(new Date().toISOString())}&name=x.png&type=image%2Fpng`;
    const putRes = await fetch(url, { method: 'PUT', body: bytes });
    expect(putRes.status).toBe(204);

    const getRes = await fetch(`${server.baseUrl}/api/v1/photos/photo-bin`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/png');
    expect(getRes.headers.get('x-content-type-options')).toBe('nosniff');
    const roundTripped = new Uint8Array(await getRes.arrayBuffer());
    expect(roundTripped).toEqual(bytes);
  });

  it('404s a missing photo', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/photos/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('deleting a photo is idempotent', async () => {
    const res1 = await fetch(`${server.baseUrl}/api/v1/photos/never-existed`, { method: 'DELETE' });
    const res2 = await fetch(`${server.baseUrl}/api/v1/photos/never-existed`, { method: 'DELETE' });
    expect(res1.status).toBe(204);
    expect(res2.status).toBe(204);
  });

  it('400s a photo upload missing required metadata query params', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/photos/incomplete?projectId=p`, {
      method: 'PUT',
      body: new Uint8Array([1])
    });
    expect(res.status).toBe(400);
  });
});

describe('settings singleton', () => {
  it('returns null before anything is saved', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('round-trips and overwrites the singleton row', async () => {
    await fetch(`${server.baseUrl}/api/v1/settings`, { method: 'PUT', body: JSON.stringify({ theme: 'dark' }) });
    let res = await fetch(`${server.baseUrl}/api/v1/settings`);
    expect(await res.json()).toEqual({ theme: 'dark' });

    await fetch(`${server.baseUrl}/api/v1/settings`, { method: 'PUT', body: JSON.stringify({ theme: 'light' }) });
    res = await fetch(`${server.baseUrl}/api/v1/settings`);
    expect(await res.json()).toEqual({ theme: 'light' });
  });
});

describe('bulk erase', () => {
  it('wipes projects, printers, photos, and settings atomically', async () => {
    await fetch(`${server.baseUrl}/api/v1/printers/p1`, { method: 'PUT', body: JSON.stringify({ id: 'p1' }) });
    await fetch(`${server.baseUrl}/api/v1/projects/proj-1`, { method: 'PUT', body: JSON.stringify({ id: 'proj-1' }) });
    await fetch(`${server.baseUrl}/api/v1/settings`, { method: 'PUT', body: JSON.stringify({ theme: 'dark' }) });
    const photoUrl =
      `${server.baseUrl}/api/v1/photos/photo-1?projectId=proj-1&stepId=s&attemptId=a` +
      `&createdAt=${encodeURIComponent(new Date().toISOString())}&name=x.png&type=image%2Fpng`;
    await fetch(photoUrl, { method: 'PUT', body: new Uint8Array([1]) });

    const eraseRes = await fetch(`${server.baseUrl}/api/v1/data`, { method: 'DELETE' });
    expect(eraseRes.status).toBe(204);

    expect(await (await fetch(`${server.baseUrl}/api/v1/printers`)).json()).toEqual([]);
    expect(await (await fetch(`${server.baseUrl}/api/v1/projects`)).json()).toEqual([]);
    expect(await (await fetch(`${server.baseUrl}/api/v1/projects/proj-1/photos`)).json()).toEqual([]);
    expect(await (await fetch(`${server.baseUrl}/api/v1/settings`)).json()).toBeNull();
  });
});

describe('unknown routes', () => {
  it('404s with a JSON error body', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});
