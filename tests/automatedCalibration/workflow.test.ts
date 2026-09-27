import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_STEPS,
  orderWorkflow,
  missingDependencies,
  stepReadiness,
  validateStepResult,
  applyStepResult,
  inputFingerprintForStep,
  markStaleJobs,
  buildWorkingProfile
} from '../../src/automatedCalibration';
import type { GeneratedJobRecord } from '../../src/automatedCalibration';
import { CALIBRATIONS, DEFAULT_ORDER } from '../../src/data/calibrations';
import type { CalibrationId, CalibrationProject } from '../../src/types';

describe('workflow registry consistency with calibrations.ts', () => {
  it('has a definition for every calibration step', () => {
    for (const id of DEFAULT_ORDER) {
      expect(WORKFLOW_STEPS[id]).toBeDefined();
      expect(WORKFLOW_STEPS[id].id).toBe(id);
    }
  });

  it('recalibrationDependsOn includes every direct dependency from calibrations.ts', () => {
    for (const id of DEFAULT_ORDER) {
      const direct = CALIBRATIONS[id as CalibrationId].dependencies;
      for (const d of direct) {
        expect(WORKFLOW_STEPS[id].recalibrationDependsOn).toContain(d);
      }
    }
  });

  it('every step except final-verification produces at least one normalized value', () => {
    for (const id of DEFAULT_ORDER) {
      if (id === 'final-verification') {
        expect(WORKFLOW_STEPS[id].produces).toEqual([]);
      } else {
        expect(WORKFLOW_STEPS[id].produces.length).toBeGreaterThan(0);
      }
    }
  });

  it('derives orca-family compatibility from step methods', () => {
    // temperature supports orca + bambu → both families represented
    expect(WORKFLOW_STEPS.temperature.compatibleSlicers).toEqual(
      expect.arrayContaining(['orca', 'snapmaker-orca', 'elegoo', 'flash-studio', 'bambu'])
    );
    // pressure-advance line/pattern methods are orca-only for some, but tower is
    // orca+bambu, so bambu is still present.
    expect(WORKFLOW_STEPS['pressure-advance'].compatibleSlicers).toContain('orca');
  });
});

describe('ordering & dependencies', () => {
  it('orders a selected subset into canonical order', () => {
    const selected: CalibrationId[] = ['retraction', 'temperature', 'flow-pass1'];
    expect(orderWorkflow(selected)).toEqual(['temperature', 'flow-pass1', 'retraction']);
  });

  it('flags a gap when a dependency step is not selected', () => {
    // flow-pass1 depends on temperature; omit temperature.
    const gaps = missingDependencies(['flow-pass1', 'pressure-advance']);
    const flowGap = gaps.find((g) => g.step === 'flow-pass1');
    expect(flowGap?.missing).toContain('temperature');
  });

  it('reports no gaps for a complete selection', () => {
    expect(missingDependencies([...DEFAULT_ORDER])).toEqual([]);
  });
});

describe('value-based readiness', () => {
  it('pressure-advance is not ready until flow ratio exists', () => {
    let wp = buildWorkingProfile({ projectId: 'p', displayName: 'w' });
    let r = stepReadiness(wp, 'pressure-advance');
    expect(r.ready).toBe(false);
    expect(r.missingInputs).toContain('flowRatio');

    wp = applyStepResult(wp, 'flow-pass1', { flowRatio: 0.98 });
    r = stepReadiness(wp, 'pressure-advance');
    expect(r.ready).toBe(true);
    expect(r.missingInputs).toEqual([]);
  });

  it('temperature (no dependencies) is always ready', () => {
    const wp = buildWorkingProfile({ projectId: 'p', displayName: 'w' });
    expect(stepReadiness(wp, 'temperature').ready).toBe(true);
  });
});

describe('result validation', () => {
  it('accepts an in-range produced value', () => {
    expect(validateStepResult('flow-pass1', { flowRatio: 0.98 })).toEqual([]);
  });

  it('rejects an out-of-range value', () => {
    const errs = validateStepResult('flow-pass1', { flowRatio: 5 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/safe range/);
  });

  it('rejects a key the step does not produce', () => {
    const errs = validateStepResult('temperature', { flowRatio: 0.98 });
    expect(errs[0]).toMatch(/not a result/);
  });

  it('rejects a non-finite value', () => {
    expect(validateStepResult('temperature', { nozzleTemp: NaN }).length).toBeGreaterThan(0);
  });
});

describe('result application', () => {
  it('applies produced values with calibration-result provenance', () => {
    const wp0 = buildWorkingProfile({ projectId: 'p', displayName: 'w' });
    const wp1 = applyStepResult(wp0, 'temperature', { nozzleTemp: 212 });
    expect(wp0.values.nozzleTemp).toBeUndefined(); // immutable
    expect(wp1.values.nozzleTemp).toBe(212);
    expect(wp1.provenance.nozzleTemp).toMatchObject({ source: 'calibration_result', stepId: 'temperature' });
  });

  it('ignores keys the step does not produce', () => {
    const wp0 = buildWorkingProfile({ projectId: 'p', displayName: 'w' });
    const wp1 = applyStepResult(wp0, 'temperature', { flowRatio: 0.9, nozzleTemp: 210 });
    expect(wp1.values.flowRatio).toBeUndefined();
    expect(wp1.values.nozzleTemp).toBe(210);
  });
});

describe('recalibration / stale downstream jobs', () => {
  function projectWithJob(): { project: CalibrationProject; job: GeneratedJobRecord } {
    // working profile with flow ratio; a PA job generated from it.
    let wp = buildWorkingProfile({ projectId: 'proj', displayName: 'w' });
    wp = applyStepResult(wp, 'flow-pass1', { flowRatio: 0.98 });
    const job: GeneratedJobRecord = {
      id: 'job-pa',
      stepId: 'pressure-advance',
      createdAt: '2026-07-26T00:00:00Z',
      engineId: 'installed_orca',
      engineVersion: '2.4.2',
      slicerMode: 'installed_orca',
      status: 'sliced',
      inputFingerprint: inputFingerprintForStep(wp, 'pressure-advance'),
      outputPath: '/tmp/plate_1.gcode',
      sliced: true,
      warnings: []
    };
    const project = { workingProfile: wp, generatedJobs: [job] } as unknown as CalibrationProject;
    return { project, job };
  }

  it('marks a downstream job stale when its upstream input changes', () => {
    const { project } = projectWithJob();
    // change the flow ratio the PA job depended on
    project.workingProfile = applyStepResult(project.workingProfile!, 'flow-verify', { flowRatio: 0.95 });
    const stale = markStaleJobs(project);
    expect(stale).toContain('job-pa');
    expect(project.generatedJobs![0].status).toBe('stale');
  });

  it('leaves a job untouched when its inputs are unchanged', () => {
    const { project } = projectWithJob();
    const stale = markStaleJobs(project);
    expect(stale).toEqual([]);
    expect(project.generatedJobs![0].status).toBe('sliced');
  });

  it('never marks a failed job stale', () => {
    const { project } = projectWithJob();
    project.generatedJobs![0].status = 'failed';
    project.workingProfile = applyStepResult(project.workingProfile!, 'flow-verify', { flowRatio: 0.9 });
    expect(markStaleJobs(project)).toEqual([]);
    expect(project.generatedJobs![0].status).toBe('failed');
  });
});
