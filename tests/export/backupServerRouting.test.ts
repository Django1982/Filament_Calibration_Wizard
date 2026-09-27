// Proves importBackup's photo-restore path goes through store.savePhoto (the
// backend-aware dispatcher) instead of bypassing it with a raw idb.put — so a
// restored photo lands on a connected server, not silently in local
// IndexedDB, matching every other write path in the app.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestServer, type TestServerHandle } from '../server/testServer.ts';
import { idb } from '../../src/storage/db';
import type { BackupFile, PrinterProfile } from '../../src/types';

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

async function freshModules() {
  vi.resetModules();
  const store = await import('../../src/storage/store');
  const backup = await import('../../src/export/backup');
  return { store, backup };
}

function makePrinter(id: string): PrinterProfile {
  return {
    id, name: 'Bench Printer', manufacturer: 'Test Co', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
    extruderType: 'direct', retractionRange: { start: 0, end: 2 },
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

describe('importBackup photo restore — with a live backend', () => {
  let server: TestServerHandle;

  beforeEach(async () => {
    await idb.clear('projects');
    await idb.clear('printers');
    await idb.clear('photos');
    server = await startTestServer();
    stubLocalStorage();
    stubRelativeFetch(server.baseUrl);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  it('restores a photo to the server, not local IndexedDB, when a backend is reachable', async () => {
    const { store, backup } = await freshModules();

    const printer = makePrinter('printer-1');
    const project = store.createProject({
      filament: { manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA', color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA' },
      printerProfileId: printer.id, nozzleType: 'brass', slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
    });

    const file: BackupFile = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: store.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: [project],
      printers: [printer],
      photos: [{
        meta: {
          id: store.uid(), projectId: project.id, stepId: 'temperature', attemptId: 'a1',
          createdAt: new Date().toISOString(), name: 'test.png', type: 'image/png'
        },
        dataUrl: 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64')
      }]
    };

    const res = await backup.importBackup(JSON.stringify(file));
    expect(res.ok).toBe(true);
    expect(res.photosImported).toBe(1);

    // Landed on the server...
    const serverPhotos = await store.getPhotosForProject(project.id);
    expect(serverPhotos).toHaveLength(1);
    expect(serverPhotos[0].name).toBe('test.png');

    // ...and not in local IndexedDB, proving the write went through the
    // backend-aware store.savePhoto dispatcher rather than a raw idb.put bypass.
    const localPhotos = await idb.getAll('photos');
    expect(localPhotos).toHaveLength(0);
  });
});

/**
 * Node has no FileReader (browser-only); exportAll's blobToDataUrl step needs
 * one. This minimal polyfill is purely a test-environment shim — the real
 * app only ever runs in a browser, where FileReader is native.
 */
class NodeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  readAsDataURL(blob: Blob): void {
    blob.arrayBuffer()
      .then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      })
      .catch((err) => { this.error = err; this.onerror?.(); });
  }
}

describe('exportAll(true) photo collection — with a live backend', () => {
  let server: TestServerHandle;

  beforeEach(async () => {
    await idb.clear('projects');
    await idb.clear('printers');
    await idb.clear('photos');
    server = await startTestServer();
    stubLocalStorage();
    stubRelativeFetch(server.baseUrl);
    vi.stubGlobal('FileReader', NodeFileReader);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  it('collects photos across every project via listAllPhotos, not a local idb.getAll bypass', async () => {
    const { store, backup } = await freshModules();

    const printer = makePrinter('printer-2');
    await store.savePrinter(printer);

    const projectA = store.createProject({
      filament: { manufacturer: 'BrandA', productLine: 'Line', material: 'PLA', color: 'Blue', diameter: 1.75, startingProfile: 'Generic PLA' },
      printerProfileId: printer.id, nozzleType: 'brass', slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
    });
    const projectB = store.createProject({
      filament: { manufacturer: 'BrandB', productLine: 'Line', material: 'PETG', color: 'Green', diameter: 1.75, startingProfile: 'Generic PETG' },
      printerProfileId: printer.id, nozzleType: 'brass', slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
    });
    await store.saveProject(projectA);
    await store.saveProject(projectB);

    await store.savePhoto({
      id: store.uid(), projectId: projectA.id, stepId: 'temperature', attemptId: 'a1',
      createdAt: new Date().toISOString(), name: 'a.png', type: 'image/png',
      blob: new Blob(['photo-a'], { type: 'image/png' })
    });
    await store.savePhoto({
      id: store.uid(), projectId: projectB.id, stepId: 'temperature', attemptId: 'a1',
      createdAt: new Date().toISOString(), name: 'b.png', type: 'image/png',
      blob: new Blob(['photo-b'], { type: 'image/png' })
    });

    const json = await backup.exportAll(true);
    const parsed = JSON.parse(json) as BackupFile;

    expect(parsed.photos).toHaveLength(2);
    expect((parsed.photos ?? []).map((p) => p.meta.name).sort()).toEqual(['a.png', 'b.png']);

    // Nothing ever touched local IndexedDB — proves the collection is
    // composed via store.listAllPhotos()'s HTTP path, not a raw idb.getAll bypass.
    const localPhotos = await idb.getAll('photos');
    expect(localPhotos).toHaveLength(0);
  });
});
