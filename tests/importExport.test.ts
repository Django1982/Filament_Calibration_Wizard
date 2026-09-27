import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// localStorage shim for Node
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear()
});

import { exportProject, importBackup, migrate, dataUrlToBlob } from '../src/export/backup';
import { createProject, savePrinter, listProjects, listPrinters, saveProject, uid, SCHEMA_VERSION } from '../src/storage/store';
import type { BackupFile, PrinterProfile } from '../src/types';
import { idb } from '../src/storage/db';

function makePrinter(): PrinterProfile {
  return {
    id: uid(), name: 'Bench Printer', manufacturer: 'Test Co', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 20,
    extruderType: 'direct', retractionRange: { start: 0, end: 2 },
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

function makeProject(printerId: string) {
  return createProject({
    filament: {
      manufacturer: 'TestBrand', productLine: 'Line', material: 'PLA',
      color: 'Red', diameter: 1.75, startingProfile: 'Generic PLA'
    },
    printerProfileId: printerId, nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' }, notes: '', mode: 'coach'
  });
}

beforeEach(async () => {
  await idb.clear('projects');
  await idb.clear('printers');
  await idb.clear('photos');
  mem.clear();
});

describe('export / import round-trip', () => {
  it('round-trips a single project with its printer', async () => {
    const printer = makePrinter();
    const project = makeProject(printer.id);
    const json = await exportProject(project, printer);

    const res = await importBackup(json);
    expect(res.ok).toBe(true);
    expect(res.projectsImported).toBe(1);
    expect(res.printersImported).toBe(1);

    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].filament.manufacturer).toBe('TestBrand');
    expect(projects[0].printerProfileId).toBe(printer.id);
  });

  it('rejects invalid JSON and foreign files', async () => {
    expect((await importBackup('not json')).ok).toBe(false);
    expect((await importBackup('{"app":"something-else","projects":[]}')).ok).toBe(false);
  });

  it('rejects files from a newer schema', async () => {
    const file = { app: 'perfectfit-filament-calibration-wizard', schemaVersion: SCHEMA_VERSION + 1, projects: [] };
    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('newer');
  });

  it('does not overwrite an existing project with the same id — imports a copy', async () => {
    const printer = makePrinter();
    await savePrinter(printer);
    const project = makeProject(printer.id);
    await saveProject(project);

    const json = await exportProject(project, printer);
    const res = await importBackup(json);
    expect(res.ok).toBe(true);

    const projects = await listProjects();
    expect(projects).toHaveLength(2);
    const ids = new Set(projects.map(p => p.id));
    expect(ids.size).toBe(2); // fresh id was assigned

    // printer with the same id is treated as the same profile, not duplicated
    expect(await listPrinters()).toHaveLength(1);
  });

  it('imports photos from a full backup', async () => {
    const printer = makePrinter();
    const project = makeProject(printer.id);
    const file: BackupFile = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: [project],
      printers: [printer],
      photos: [{
        meta: {
          id: uid(), projectId: project.id, stepId: 'temperature', attemptId: 'a1',
          createdAt: new Date().toISOString(), name: 'test.png', type: 'image/png'
        },
        dataUrl: 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64')
      }]
    };
    const res = await importBackup(JSON.stringify(file));
    expect(res.ok).toBe(true);
    expect(res.photosImported).toBe(1);
  });
});

describe('data migration', () => {
  it('normalizes missing arrays and fields from older/partial files', () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: 0,
      exportedAt: '',
      projects: [{
        id: 'x', filament: {}, steps: { temperature: { status: 'completed', current: null } },
        stepOrder: ['temperature']
      }],
      printers: []
    } as unknown as BackupFile;
    const out = migrate(file);
    expect(out.schemaVersion).toBe(5);
    const p = out.projects[0];
    expect(Array.isArray(p.timeline)).toBe(true);
    expect(p.finals).toBeDefined();
    expect(p.generatedProfiles).toEqual([]);
    expect(Array.isArray((p.steps as Record<string, { history: unknown[] }>).temperature.history)).toBe(true);
  });

  it('adds v3 steps (flow-verify, shrinkage) to older projects at canonical positions', () => {
    const file = {
      app: 'perfectfit-filament-calibration-wizard',
      schemaVersion: 2,
      exportedAt: '',
      projects: [{
        id: 'x', filament: {}, finals: {}, timeline: [],
        steps: {
          temperature: { status: 'completed', current: null, history: [] },
          'pressure-advance': { status: 'completed', current: null, history: [] }
        },
        stepOrder: ['temperature', 'flow-pass1', 'flow-pass2', 'pressure-advance', 'retraction', 'max-volumetric-speed', 'final-verification']
      }],
      printers: []
    } as unknown as BackupFile;
    const out = migrate(file);
    const p = out.projects[0];
    expect(p.stepOrder).toEqual([
      'temperature', 'flow-pass1', 'flow-pass2', 'pressure-advance',
      'flow-verify', 'retraction', 'max-volumetric-speed', 'shrinkage', 'final-verification'
    ]);
    expect(p.steps['flow-verify'].status).toBe('not-started');
    expect(p.steps.shrinkage.status).toBe('not-started');
    // Existing progress untouched.
    expect(p.steps.temperature.status).toBe('completed');
  });
});

describe('dataUrl helpers', () => {
  it('decodes data URLs to blobs with the right mime', () => {
    const blob = dataUrlToBlob('data:image/png;base64,' + Buffer.from('abc').toString('base64'));
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
  });
});
