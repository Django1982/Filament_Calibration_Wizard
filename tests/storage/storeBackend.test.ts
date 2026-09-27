// Integration tests proving store.ts's dispatcher path actually talks to a
// real Phase 1 server when one is reachable, and that it stays on the
// existing IndexedDB path unchanged when it isn't.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestServer, type TestServerHandle } from '../server/testServer.ts';
import type { PrinterProfile, StoredPhoto } from '../../src/types';

const mem = new Map<string, string>();

function stubLocalStorage(): void {
  mem.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear()
  });
}

/** Rewrites store.ts's relative `./api/v1/...` fetches onto the real test server's origin. */
function stubRelativeFetch(baseUrl: string): void {
  const realFetch = fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? new URL(input, `${baseUrl}/`).toString() : input;
    return realFetch(url as RequestInfo, init);
  });
}

function makePrinter(id: string): PrinterProfile {
  return {
    id, name: 'Bench Printer', manufacturer: 'Test Co', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
    extruderType: 'direct', retractionRange: { start: 0, end: 2 },
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

async function freshStore() {
  vi.resetModules();
  return import('../../src/storage/store');
}

describe('store.ts dispatch — with a live backend', () => {
  let server: TestServerHandle;

  beforeEach(async () => {
    server = await startTestServer();
    stubLocalStorage();
    stubRelativeFetch(server.baseUrl);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  it('round-trips a printer over the network, not IndexedDB', async () => {
    const store = await freshStore();
    const printer = makePrinter('printer-http-1');

    await store.savePrinter(printer);
    const fetched = await store.getPrinter('printer-http-1');
    expect(fetched?.id).toBe('printer-http-1');

    // Confirm it actually landed server-side (not just in a local fallback).
    const res = await fetch(`${server.baseUrl}/api/v1/printers/printer-http-1`);
    expect(res.status).toBe(200);

    const all = await store.listPrinters();
    expect(all.map((p) => p.id)).toContain('printer-http-1');

    await store.deletePrinter('printer-http-1');
    expect(await store.getPrinter('printer-http-1')).toBeUndefined();
  });

  it('round-trips a project including ensureProjectSteps normalization', async () => {
    const store = await freshStore();
    const printer = makePrinter('printer-http-2');
    await store.savePrinter(printer);

    const project = store.createProject({
      filament: { manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA', color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA' },
      printerProfileId: printer.id, nozzleType: 'brass',
      slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
    });

    await store.saveProject(project);
    const fetched = await store.getProject(project.id);
    expect(fetched?.id).toBe(project.id);
    expect(fetched?.stepOrder.length).toBeGreaterThan(0);

    const listed = await store.listProjects();
    expect(listed.map((p) => p.id)).toContain(project.id);
  });

  it('cascade-deletes a project\'s photos server-side on deleteProject', async () => {
    const store = await freshStore();
    const project = store.createProject({
      filament: { manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA', color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA' },
      printerProfileId: 'printer-x', nozzleType: 'brass',
      slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
    });
    await store.saveProject(project);

    const photo: StoredPhoto = {
      id: 'photo-http-1', projectId: project.id, stepId: 'temperature', attemptId: 'a1',
      createdAt: new Date().toISOString(), name: 'x.png', type: 'image/png',
      blob: new Blob(['bytes'], { type: 'image/png' })
    };
    await store.savePhoto(photo);

    const before = await store.getPhotosForProject(project.id);
    expect(before).toHaveLength(1);
    expect(before[0].blob).toBeInstanceOf(Blob);
    expect(await before[0].blob.text()).toBe('bytes');

    await store.deleteProject(project.id);

    const after = await fetch(`${server.baseUrl}/api/v1/projects/${project.id}/photos`);
    expect(await after.json()).toEqual([]);
  });

  it('round-trips settings via http.putSettings/getSettings semantics through the bridge directly', async () => {
    const { http } = await import('../../src/storage/serverBridge');
    await http.putSettings({ theme: 'dark', largeText: false, defaultMode: 'coach', mvsSafetyMargin: 0.85 });
    expect(await http.getSettings()).toEqual({ theme: 'dark', largeText: false, defaultMode: 'coach', mvsSafetyMargin: 0.85 });
  });
});

describe('store.ts dispatch — no backend reachable', () => {
  beforeEach(() => {
    stubLocalStorage();
    // Point fetch at a host nothing is listening on so detectBackend's probe fails fast.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the existing IndexedDB path exactly as before', async () => {
    const store = await freshStore();
    const printer = makePrinter('printer-idb-1');

    await store.savePrinter(printer);
    const fetched = await store.getPrinter('printer-idb-1');
    expect(fetched?.id).toBe('printer-idb-1');

    const all = await store.listPrinters();
    expect(all.map((p) => p.id)).toContain('printer-idb-1');

    await store.deletePrinter('printer-idb-1');
    expect(await store.getPrinter('printer-idb-1')).toBeUndefined();
  });

  it('project + photo CRUD still works entirely locally', async () => {
    const store = await freshStore();
    const project = store.createProject({
      filament: { manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA', color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA' },
      printerProfileId: 'printer-idb-2', nozzleType: 'brass',
      slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
    });
    await store.saveProject(project);

    const photo: StoredPhoto = {
      id: 'photo-idb-1', projectId: project.id, stepId: 'temperature', attemptId: 'a1',
      createdAt: new Date().toISOString(), name: 'x.png', type: 'image/png',
      blob: new Blob(['bytes'], { type: 'image/png' })
    };
    await store.savePhoto(photo);
    expect(await store.getPhotosForProject(project.id)).toHaveLength(1);

    await store.deleteProject(project.id);
    expect(await store.getProject(project.id)).toBeUndefined();
    expect(await store.getPhotosForProject(project.id)).toHaveLength(0);
  });
});
