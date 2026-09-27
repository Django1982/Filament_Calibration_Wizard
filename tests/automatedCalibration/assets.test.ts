import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  resolveAsset,
  joinResourcePath,
  prepareJob,
  workspaceDirName,
  isPerfectFitWorkspaceName,
  buildWorkingProfile,
  applyStepResult
} from '../../src/automatedCalibration';
import type { CalibrationProject } from '../../src/types';
import type { PrinterSelection } from '../../src/automatedCalibration';

const ORCA_ROOT_POSIX = '/opt/OrcaSlicer/resources';
const ORCA_ROOT_WIN = 'C:\\Program Files\\OrcaSlicer\\resources';
const PRINTER: PrinterSelection = { printerProfileId: 'p1', nozzleDiameterMm: 0.4, slicer: 'orca' };

function projectWithFlow(flowRatio?: number): CalibrationProject {
  let wp = buildWorkingProfile({ projectId: 'proj1', displayName: 'w' });
  wp = applyStepResult(wp, 'temperature', { nozzleTemp: 210 });
  if (flowRatio !== undefined) wp = applyStepResult(wp, 'flow-pass1', { flowRatio });
  return { id: 'proj1', workingProfile: wp } as unknown as CalibrationProject;
}

describe('joinResourcePath', () => {
  it('joins with the posix separator for a posix root', () => {
    expect(joinResourcePath(ORCA_ROOT_POSIX, 'calib/temperature_tower/temperature_tower.stl')).toBe(
      '/opt/OrcaSlicer/resources/calib/temperature_tower/temperature_tower.stl'
    );
  });

  it('joins with backslashes for a windows root', () => {
    const p = joinResourcePath(ORCA_ROOT_WIN, 'calib/temperature_tower/temperature_tower.stl');
    expect(p.startsWith('C:\\Program Files\\OrcaSlicer\\resources\\')).toBe(true);
    expect(p.endsWith('temperature_tower.stl')).toBe(true);
    expect(p.includes('/')).toBe(false);
  });
});

describe('asset resolution', () => {
  it('resolves a built-in test from the installed slicer resources', () => {
    const r = resolveAsset('temperature', { slicerResourceRoot: ORCA_ROOT_POSIX });
    expect(r.available).toBe(true);
    expect(r.sourceKind).toBe('installed-slicer-resource');
    expect(r.location).toContain('temperature_tower.stl');
    expect(r.requiresParameterization).toBe(true);
  });

  it('prefers a user-provided file over the installed resource', () => {
    const r = resolveAsset('temperature', {
      slicerResourceRoot: ORCA_ROOT_POSIX,
      userProvidedPath: '/home/user/my-tower.stl'
    });
    expect(r.sourceKind).toBe('user-provided');
    expect(r.location).toBe('/home/user/my-tower.stl');
  });

  it('treats max volumetric speed as generated (no model file)', () => {
    const r = resolveAsset('max-volumetric-speed', { slicerResourceRoot: ORCA_ROOT_POSIX });
    expect(r.available).toBe(true);
    expect(r.sourceKind).toBe('generated');
    expect(r.location).toBeNull();
  });

  it('is unavailable with a clear remedy when no allowed source exists', () => {
    const r = resolveAsset('temperature', {});
    expect(r.available).toBe(false);
    expect(r.sourceKind).toBeNull();
    expect(r.remedy).toMatch(/OrcaSlicer/i);
  });

  it('NEVER auto-downloads a non-redistributable model, even if downloads are allowed', () => {
    // final-verification (3DBenchy, CC BY-ND) has a downloadUrl but is not redistributable.
    const r = resolveAsset('final-verification', { allowDownload: true });
    expect(r.available).toBe(false);
    expect(r.sourceKind).not.toBe('download');
    expect(r.remedy).toMatch(/download it from/i);
  });
});

describe('project preparation (unsliced)', () => {
  it('produces a manifest that is never printer-ready', () => {
    const plan = prepareJob({
      project: projectWithFlow(0.98),
      stepId: 'pressure-advance',
      slicerMode: 'installed_orca',
      printerSelection: PRINTER,
      nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT_POSIX },
      jobId: 'job1'
    });
    expect(plan.ok).toBe(true);
    expect(plan.manifest.sliced).toBe(false);
    // working-profile values are snapshotted into the manifest
    expect(plan.manifest.appliedValues.nozzleTemp).toBe(210);
    expect(plan.manifest.appliedValues.flowRatio).toBe(0.98);
    expect(plan.manifest.asset.sourceKind).toBe('installed-slicer-resource');
    // planned files: a model, the generated config, custom g-code, and the manifest
    const roles = plan.plannedFiles.map((f) => f.role);
    expect(roles).toEqual(expect.arrayContaining(['model', 'project-config', 'custom-gcode', 'manifest']));
  });

  it('omits the model file for a generated (no-model) step', () => {
    const plan = prepareJob({
      project: projectWithFlow(0.98),
      stepId: 'max-volumetric-speed',
      slicerMode: 'installed_orca',
      printerSelection: PRINTER,
      nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT_POSIX },
      jobId: 'job2'
    });
    expect(plan.ok).toBe(true);
    expect(plan.plannedFiles.some((f) => f.role === 'model')).toBe(false);
    expect(plan.plannedFiles.some((f) => f.role === 'project-config')).toBe(true);
  });

  it('is not ok (but still crash-free) when the asset cannot be resolved', () => {
    const plan = prepareJob({
      project: projectWithFlow(0.98),
      stepId: 'pressure-advance',
      slicerMode: 'installed_orca',
      printerSelection: PRINTER,
      nozzleDiameterMm: 0.4,
      assetContext: {}, // no root, no user file
      jobId: 'job3'
    });
    expect(plan.ok).toBe(false);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.manifest.sliced).toBe(false);
  });

  it('names workspaces deterministically and distinctly by input', () => {
    const a = prepareJob({
      project: projectWithFlow(0.98), stepId: 'pressure-advance', slicerMode: 'installed_orca',
      printerSelection: PRINTER, nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT_POSIX }, jobId: 'jA'
    }).workspaceDirName;
    const aAgain = prepareJob({
      project: projectWithFlow(0.98), stepId: 'pressure-advance', slicerMode: 'installed_orca',
      printerSelection: PRINTER, nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT_POSIX }, jobId: 'jA2'
    }).workspaceDirName;
    const b = prepareJob({
      project: projectWithFlow(0.95), stepId: 'pressure-advance', slicerMode: 'installed_orca',
      printerSelection: PRINTER, nozzleDiameterMm: 0.4,
      assetContext: { slicerResourceRoot: ORCA_ROOT_POSIX }, jobId: 'jB'
    }).workspaceDirName;
    expect(a).toBe(aAgain);          // same inputs → same workspace (idempotent)
    expect(a).not.toBe(b);           // changed upstream input → distinct workspace
  });
});

describe('workspace cleanup guard', () => {
  it('recognizes only PerfectFit-owned workspace names', () => {
    const name = workspaceDirName('proj1', 'temperature', 'fp');
    expect(isPerfectFitWorkspaceName(name)).toBe(true);
    expect(isPerfectFitWorkspaceName('some-user-folder')).toBe(false);
    expect(isPerfectFitWorkspaceName('..')).toBe(false);
  });
});

describe('redistributable test fixture', () => {
  it('unit-cube.stl is a valid, self-authored ASCII STL', () => {
    const stl = readFileSync(new URL('./fixtures/unit-cube.stl', import.meta.url), 'utf8');
    expect(stl.startsWith('solid perfectfit_unit_cube')).toBe(true);
    expect((stl.match(/facet normal/g) ?? []).length).toBe(12);
    expect(stl.trimEnd().endsWith('endsolid perfectfit_unit_cube')).toBe(true);
  });
});
