import { describe, it, expect } from 'vitest';
import {
  createTemporaryProfile,
  applyValue,
  valuesFromSource,
  fingerprintValues,
  jobIsStale,
  isSessionResumable,
  emptyEngineCapabilities,
  supported,
  unsupported,
  isAutomatedCalibrationEnabled
} from '../../src/automatedCalibration';
import type { GeneratedJobRecord } from '../../src/automatedCalibration';
import {
  DEFAULT_EXPERIMENTAL_FEATURES,
  type ExperimentalFeatures
} from '../../src/slicerIntegration/types';

const AT = '2026-07-26T00:00:00.000Z';

describe('temporary working profile', () => {
  it('creates an empty profile with provenance/value maps and timestamps', () => {
    const p = createTemporaryProfile({ id: 'wp1', displayName: 'Test', projectId: 'proj1', now: AT });
    expect(p.values).toEqual({});
    expect(p.provenance).toEqual({});
    expect(p.createdAt).toBe(AT);
    expect(p.updatedAt).toBe(AT);
    expect(p.createdForProjectId).toBe('proj1');
  });

  it('applyValue records the value + provenance without mutating the input', () => {
    const p0 = createTemporaryProfile({ id: 'wp1', displayName: 'Test', projectId: 'proj1', now: AT });
    const p1 = applyValue(p0, 'nozzleTemp', 215, 'calibration_result', {
      stepId: 'temperature',
      now: '2026-07-26T01:00:00.000Z'
    });
    // original untouched
    expect(p0.values).toEqual({});
    // new profile has the value + provenance
    expect(p1.values.nozzleTemp).toBe(215);
    expect(p1.provenance.nozzleTemp).toEqual({
      source: 'calibration_result',
      stepId: 'temperature',
      updatedAt: '2026-07-26T01:00:00.000Z'
    });
    expect(p1.updatedAt).toBe('2026-07-26T01:00:00.000Z');
  });

  it('valuesFromSource filters by provenance source', () => {
    let p = createTemporaryProfile({ id: 'wp1', displayName: 'T', projectId: 'proj1', now: AT });
    p = applyValue(p, 'nozzleTemp', 215, 'calibration_result', { now: AT });
    p = applyValue(p, 'flowRatio', 0.98, 'calibration_result', { now: AT });
    p = applyValue(p, 'bedTemp', 60, 'material_default', { now: AT });
    expect(valuesFromSource(p, 'calibration_result')).toEqual(['flowRatio', 'nozzleTemp']);
    expect(valuesFromSource(p, 'material_default')).toEqual(['bedTemp']);
    expect(valuesFromSource(p, 'user_input')).toEqual([]);
  });
});

describe('fingerprintValues', () => {
  it('is independent of key insertion order', () => {
    const a = fingerprintValues({ nozzleTemp: 215, flowRatio: 0.98 });
    const b = fingerprintValues({ flowRatio: 0.98, nozzleTemp: 215 });
    expect(a).toBe(b);
  });

  it('changes when a value changes', () => {
    const a = fingerprintValues({ nozzleTemp: 215 });
    const b = fingerprintValues({ nozzleTemp: 216 });
    expect(a).not.toBe(b);
  });
});

describe('jobIsStale', () => {
  const baseJob = (over: Partial<GeneratedJobRecord>): GeneratedJobRecord => ({
    id: 'j1',
    stepId: 'temperature',
    createdAt: AT,
    engineId: 'installed_orca',
    engineVersion: '2.4.2',
    slicerMode: 'installed_orca',
    status: 'sliced',
    inputFingerprint: 'FP-A',
    outputPath: '/tmp/plate_1.gcode',
    sliced: true,
    warnings: [],
    ...over
  });

  it('is stale when the current fingerprint differs', () => {
    expect(jobIsStale(baseJob({}), 'FP-B')).toBe(true);
  });

  it('is not stale when the fingerprint matches', () => {
    expect(jobIsStale(baseJob({}), 'FP-A')).toBe(false);
  });

  it('a failed job is never "stale" (it is re-run instead)', () => {
    expect(jobIsStale(baseJob({ status: 'failed' }), 'FP-B')).toBe(false);
  });
});

describe('isSessionResumable', () => {
  it('resumes in-progress states', () => {
    expect(isSessionResumable('created')).toBe(true);
    expect(isSessionResumable('in_progress')).toBe(true);
    expect(isSessionResumable('waiting_for_print')).toBe(true);
    expect(isSessionResumable('waiting_for_result')).toBe(true);
  });

  it('does not resume terminal states', () => {
    expect(isSessionResumable('completed')).toBe(false);
    expect(isSessionResumable('cancelled')).toBe(false);
    expect(isSessionResumable('failed')).toBe(false);
  });
});

describe('capability constructors', () => {
  it('emptyEngineCapabilities is all-false', () => {
    expect(emptyEngineCapabilities()).toEqual({
      slice: false,
      export3mf: false,
      exportGcode: false,
      multiPlate: false,
      multiExtruder: false
    });
  });

  it('supported/unsupported build consistent results', () => {
    expect(supported()).toEqual({ supported: true, reasons: [] });
    expect(unsupported('no engine', 'no exe')).toEqual({
      supported: false,
      reasons: ['no engine', 'no exe']
    });
  });
});

describe('automated calibration feature flag', () => {
  it('is disabled by default', () => {
    expect(isAutomatedCalibrationEnabled(DEFAULT_EXPERIMENTAL_FEATURES)).toBe(false);
  });

  it('is enabled only when the flag is explicitly true', () => {
    const on: ExperimentalFeatures = { ...DEFAULT_EXPERIMENTAL_FEATURES, automatedCalibration: true };
    expect(isAutomatedCalibrationEnabled(on)).toBe(true);
  });
});
