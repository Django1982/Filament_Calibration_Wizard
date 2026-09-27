import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

import {
  buildWorkingProfile,
  beginSession,
  canTransition,
  setSessionStatus,
  cancelSession,
  completeSession,
  validateWorkingProfile,
  validateSession,
  loadSessionSafe,
  hasAutomatedSession,
  isResumable,
  resumableSessions
} from '../../src/automatedCalibration';
import { createProject, saveProject, getProject } from '../../src/storage/store';
import type { CalibrationProject } from '../../src/types';

function makeProject(): CalibrationProject {
  return createProject({
    filament: {
      manufacturer: 'Acme', productLine: 'Basic', material: 'PLA',
      color: 'Black', diameter: 1.75, startingProfile: 'Generic PLA'
    },
    printerProfileId: 'printer-1',
    nozzleType: 'brass',
    slicer: { slicer: 'orca', version: '2.4.x' },
    notes: '',
    mode: 'coach'
  });
}

function startedProject(): CalibrationProject {
  const p = makeProject();
  const wp = buildWorkingProfile({
    projectId: p.id,
    displayName: 'PLA working',
    sourceProfileName: 'Generic PLA',
    seeds: [
      { key: 'bedTemp', value: 60, source: 'material_default' },
      { key: 'nozzleTemp', value: 210, source: 'material_default' }
    ]
  });
  return beginSession(p, { slicerMode: 'installed_orca', engineId: 'installed_orca', workingProfile: wp });
}

describe('buildWorkingProfile', () => {
  it('creates a profile seeded with provenance-tagged values', () => {
    const wp = buildWorkingProfile({
      projectId: 'proj1',
      displayName: 'PLA',
      seeds: [{ key: 'bedTemp', value: 60, source: 'material_default' }]
    });
    expect(wp.createdForProjectId).toBe('proj1');
    expect(wp.values.bedTemp).toBe(60);
    expect(wp.provenance.bedTemp.source).toBe('material_default');
    expect(wp.id).toBeTruthy();
  });
});

describe('beginSession', () => {
  it('attaches an automated session without touching calibration results', () => {
    const p = makeProject();
    const stepsBefore = JSON.stringify(p.steps);
    const finalsBefore = JSON.stringify(p.finals);
    startAndAssert(p);
    // results untouched
    expect(JSON.stringify(p.steps)).toBe(stepsBefore);
    expect(JSON.stringify(p.finals)).toBe(finalsBefore);
  });

  function startAndAssert(p: CalibrationProject) {
    const wp = buildWorkingProfile({ projectId: p.id, displayName: 'w' });
    beginSession(p, { slicerMode: 'managed_orca', workingProfile: wp });
    expect(p.sessionStatus).toBe('created');
    expect(p.slicerMode).toBe('managed_orca');
    expect(p.workingProfile).toBe(wp);
    expect(p.generatedJobs).toEqual([]);
    expect(hasAutomatedSession(p)).toBe(true);
  }
});

describe('status transitions', () => {
  it('allows legal moves and same-status no-ops', () => {
    expect(canTransition('created', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'waiting_for_print')).toBe(true);
    expect(canTransition('waiting_for_result', 'completed')).toBe(true);
    expect(canTransition('failed', 'in_progress')).toBe(true);
    expect(canTransition('created', 'created')).toBe(true);
  });

  it('rejects illegal and post-terminal moves', () => {
    expect(canTransition('created', 'completed')).toBe(false);
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('cancelled', 'in_progress')).toBe(false);
  });

  it('setSessionStatus applies legal transitions and refuses illegal ones', () => {
    const p = startedProject();
    expect(setSessionStatus(p, 'in_progress').ok).toBe(true);
    expect(p.sessionStatus).toBe('in_progress');

    const bad = setSessionStatus(p, 'created');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/cannot move/i);
    expect(p.sessionStatus).toBe('in_progress'); // unchanged
  });

  it('complete then no further transitions', () => {
    const p = startedProject();
    setSessionStatus(p, 'in_progress');
    expect(completeSession(p).ok).toBe(true);
    expect(p.sessionStatus).toBe('completed');
    expect(cancelSession(p).ok).toBe(false);
  });

  it('setSessionStatus on a project with no session fails cleanly', () => {
    const p = makeProject();
    const r = setSessionStatus(p, 'in_progress');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no automated session/i);
  });
});

describe('validation', () => {
  it('accepts a well-formed session', () => {
    expect(validateSession(startedProject())).toEqual([]);
  });

  it('flags provenance without a matching value', () => {
    const wp = buildWorkingProfile({ projectId: 'p', displayName: 'w' });
    // corrupt: provenance key with no value
    (wp.provenance as Record<string, unknown>).ghost = { source: 'user_input', updatedAt: 'x' };
    const errs = validateWorkingProfile(wp);
    expect(errs.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('flags a missing working profile', () => {
    expect(validateWorkingProfile(undefined).length).toBeGreaterThan(0);
    expect(validateWorkingProfile(null).length).toBeGreaterThan(0);
  });
});

describe('loadSessionSafe (corruption recovery)', () => {
  it('passes a clean session through unchanged', () => {
    const p = startedProject();
    const res = loadSessionSafe(p);
    expect(res.automated).toBe(true);
    expect(res.degraded).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(p.workingProfile).toBeDefined();
  });

  it('reports "no session" for a plain manual project', () => {
    const res = loadSessionSafe(makeProject());
    expect(res.automated).toBe(false);
    expect(res.degraded).toBe(false);
  });

  it('sets aside a corrupt session but preserves calibration data', () => {
    const p = startedProject();
    // Simulate corruption: session status present but working profile broken.
    (p as unknown as { workingProfile: unknown }).workingProfile = { id: '', values: null };
    const timelineBefore = p.timeline.length;
    const stepsBefore = JSON.stringify(p.steps);

    const res = loadSessionSafe(p);
    expect(res.automated).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    // session scaffolding stripped…
    expect(p.sessionStatus).toBeUndefined();
    expect(p.workingProfile).toBeUndefined();
    // …but real user data untouched.
    expect(JSON.stringify(p.steps)).toBe(stepsBefore);
    expect(p.timeline.length).toBe(timelineBefore);
  });
});

describe('resume queries', () => {
  it('isResumable is true for in-progress sessions, false for terminal', () => {
    const p = startedProject();
    setSessionStatus(p, 'in_progress');
    expect(isResumable(p)).toBe(true);
    completeSession(p);
    expect(isResumable(p)).toBe(false);
  });

  it('resumableSessions filters a mixed list', () => {
    const active = startedProject();
    const done = startedProject();
    setSessionStatus(done, 'in_progress');
    completeSession(done);
    const manual = makeProject();
    const list = resumableSessions([active, done, manual]);
    expect(list).toContain(active);
    expect(list).not.toContain(done);
    expect(list).not.toContain(manual);
  });
});

describe('durability across a simulated restart (IndexedDB)', () => {
  it('a working profile and session survive save + reload', async () => {
    const p = startedProject();
    setSessionStatus(p, 'in_progress');
    await saveProject(p);

    const reloaded = await getProject(p.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.sessionStatus).toBe('in_progress');
    expect(reloaded!.slicerMode).toBe('installed_orca');
    expect(reloaded!.workingProfile?.values.nozzleTemp).toBe(210);
    expect(reloaded!.workingProfile?.provenance.nozzleTemp.source).toBe('material_default');
    expect(Array.isArray(reloaded!.generatedJobs)).toBe(true);

    // and the reloaded session validates + is resumable
    expect(validateSession(reloaded!)).toEqual([]);
    expect(isResumable(reloaded!)).toBe(true);
  });
});
