// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — workflow registry & result inheritance (Stage 3).
//
// Turns the instructional calibration content in `src/data/calibrations.ts` into
// a dependency-aware workflow the automated pipeline can drive: what each step
// consumes and produces, how a result updates the working profile, and which
// downstream generated jobs go stale when an upstream result changes.
//
// The dependency graph and slicer compatibility are DERIVED from calibrations.ts
// (the single source of truth) so the two can never drift. Only the intrinsic
// facts that aren't expressible there (normalized outputs, safe ranges, whether
// a step is sliced) are declared here. Coach Mode and all instructional content
// stay in calibrations.ts, untouched.
//
// Pure module: no storage, DOM, or filesystem. Gated behind the disabled flag.
// ---------------------------------------------------------------------------

import type { CalibrationId, CalibrationProject } from '../types';
import { CALIBRATIONS, DEFAULT_ORDER } from '../data/calibrations';
import type { IntegrationSlicerId } from '../slicerIntegration/types';
import type { CalibrationStepDefinition, TemporaryCalibrationProfile } from './types';
import { applyValue, fingerprintValues, jobIsStale } from './session';

/** Canonical normalized working-profile keys (aligned with `FinalValues`). */
export type NormalizedProfileKey =
  | 'nozzleTemp'
  | 'firstLayerTemp'
  | 'highFlowTemp'
  | 'bedTemp'
  | 'flowRatio'
  | 'pressureAdvance'
  | 'retractionDistance'
  | 'retractionSpeed'
  | 'maxVolumetricSpeed'
  | 'shrinkagePercent';

/** A normalized calibration result: normalized keys → measured values. */
export type StepResultValues = Partial<Record<NormalizedProfileKey, number>>;

interface StepSpec {
  produces: NormalizedProfileKey[];
  valueRanges: Partial<Record<NormalizedProfileKey, { min: number; max: number }>>;
  needsSlicing: boolean;
  supportsManualFiles: boolean;
}

// Intrinsic per-step facts not derivable from calibrations.ts.
const STEP_SPECS: Record<CalibrationId, StepSpec> = {
  temperature: {
    produces: ['nozzleTemp'],
    valueRanges: { nozzleTemp: { min: 150, max: 320 } },
    needsSlicing: true,
    supportsManualFiles: false
  },
  'flow-pass1': {
    produces: ['flowRatio'],
    valueRanges: { flowRatio: { min: 0.8, max: 1.2 } },
    needsSlicing: true,
    supportsManualFiles: false
  },
  'flow-pass2': {
    produces: ['flowRatio'],
    valueRanges: { flowRatio: { min: 0.8, max: 1.2 } },
    needsSlicing: true,
    supportsManualFiles: false
  },
  'pressure-advance': {
    produces: ['pressureAdvance'],
    valueRanges: { pressureAdvance: { min: 0, max: 2 } },
    needsSlicing: true,
    supportsManualFiles: false
  },
  'flow-verify': {
    produces: ['flowRatio'],
    valueRanges: { flowRatio: { min: 0.8, max: 1.2 } },
    needsSlicing: true,
    supportsManualFiles: false
  },
  retraction: {
    produces: ['retractionDistance', 'retractionSpeed'],
    valueRanges: {
      retractionDistance: { min: 0, max: 10 },
      retractionSpeed: { min: 0, max: 100 }
    },
    needsSlicing: true,
    supportsManualFiles: true
  },
  'max-volumetric-speed': {
    produces: ['maxVolumetricSpeed'],
    valueRanges: { maxVolumetricSpeed: { min: 1, max: 60 } },
    needsSlicing: true,
    supportsManualFiles: true
  },
  shrinkage: {
    produces: ['shrinkagePercent'],
    valueRanges: { shrinkagePercent: { min: 90, max: 102 } },
    needsSlicing: true,
    supportsManualFiles: true
  },
  'final-verification': {
    produces: [],
    valueRanges: {},
    needsSlicing: true,
    supportsManualFiles: true
  }
};

/** Transitive dependency closure of a step, derived from calibrations.ts. */
function transitiveDeps(id: CalibrationId): CalibrationId[] {
  const seen = new Set<CalibrationId>();
  const visit = (x: CalibrationId): void => {
    for (const d of CALIBRATIONS[x].dependencies) {
      if (!seen.has(d)) {
        seen.add(d);
        visit(d);
      }
    }
  };
  visit(id);
  return DEFAULT_ORDER.filter((s) => seen.has(s)); // stable canonical order
}

/** Normalized keys a step needs, = what its DIRECT dependencies produce. */
function requiredInputsFor(id: CalibrationId): NormalizedProfileKey[] {
  const keys = new Set<NormalizedProfileKey>();
  for (const dep of CALIBRATIONS[id].dependencies) {
    for (const k of STEP_SPECS[dep].produces) keys.add(k);
  }
  return [...keys];
}

/** Which integration slicers a step supports, derived from its methods. */
function compatibleSlicersFor(id: CalibrationId): IntegrationSlicerId[] {
  const wizardSlicers = new Set(CALIBRATIONS[id].methods.flatMap((m) => m.slicers));
  const out = new Set<IntegrationSlicerId>();
  if (wizardSlicers.has('orca')) {
    // Orca and its forks behave identically for calibration purposes.
    (['orca', 'snapmaker-orca', 'elegoo', 'flash-studio'] as IntegrationSlicerId[]).forEach((s) =>
      out.add(s)
    );
  }
  if (wizardSlicers.has('bambu')) out.add('bambu');
  return [...out];
}

function buildStepDefinition(id: CalibrationId): CalibrationStepDefinition {
  const spec = STEP_SPECS[id];
  return {
    id,
    requiredInputs: requiredInputsFor(id),
    optionalInputs: [],
    produces: spec.produces,
    needsSlicing: spec.needsSlicing,
    supportsManualFiles: spec.supportsManualFiles,
    compatibleSlicers: compatibleSlicersFor(id),
    valueRanges: spec.valueRanges,
    recalibrationDependsOn: transitiveDeps(id)
  };
}

/** The workflow registry: one dependency-aware definition per calibration step. */
export const WORKFLOW_STEPS: Record<CalibrationId, CalibrationStepDefinition> = DEFAULT_ORDER.reduce(
  (acc, id) => {
    acc[id] = buildStepDefinition(id);
    return acc;
  },
  {} as Record<CalibrationId, CalibrationStepDefinition>
);

export function getStepDefinition(id: CalibrationId): CalibrationStepDefinition {
  return WORKFLOW_STEPS[id];
}

// --- workflow ordering ------------------------------------------------------

/** Order a selected set of steps into the canonical, dependency-respecting
 *  sequence (a filtered `DEFAULT_ORDER`). */
export function orderWorkflow(selected: CalibrationId[]): CalibrationId[] {
  const set = new Set(selected);
  return DEFAULT_ORDER.filter((id) => set.has(id));
}

/** Structural check: for each selected step, which of its direct dependency
 *  STEPS are absent from the selection (i.e. would leave a gap). */
export function missingDependencies(
  selected: CalibrationId[]
): { step: CalibrationId; missing: CalibrationId[] }[] {
  const set = new Set(selected);
  const out: { step: CalibrationId; missing: CalibrationId[] }[] = [];
  for (const id of selected) {
    const missing = CALIBRATIONS[id].dependencies.filter((d) => !set.has(d));
    if (missing.length) out.push({ step: id, missing });
  }
  return out;
}

// --- readiness (value-based) ------------------------------------------------

export interface StepReadiness {
  ready: boolean;
  missingInputs: NormalizedProfileKey[];
}

/** Whether a step's required input VALUES are present in the working profile
 *  (regardless of which upstream step supplied them, so a manually entered or
 *  skipped-but-known value still satisfies the requirement). */
export function stepReadiness(
  profile: TemporaryCalibrationProfile | undefined,
  stepId: CalibrationId
): StepReadiness {
  const req = WORKFLOW_STEPS[stepId].requiredInputs as NormalizedProfileKey[];
  const values = profile?.values ?? {};
  const missingInputs = req.filter((k) => !(k in values));
  return { ready: missingInputs.length === 0, missingInputs };
}

// --- result validation & application ---------------------------------------

/** Validate a normalized result against the step's produced keys and ranges. */
export function validateStepResult(stepId: CalibrationId, result: StepResultValues): string[] {
  const def = WORKFLOW_STEPS[stepId];
  const produced = new Set(def.produces);
  const errors: string[] = [];
  for (const key of Object.keys(result) as NormalizedProfileKey[]) {
    if (!produced.has(key)) {
      errors.push(`"${key}" is not a result of the ${stepId} step`);
      continue;
    }
    const val = result[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      errors.push(`"${key}" must be a finite number`);
      continue;
    }
    const range = def.valueRanges[key];
    if (range && (val < range.min || val > range.max)) {
      errors.push(`"${key}" (${val}) is outside the safe range ${range.min}–${range.max}`);
    }
  }
  return errors;
}

/** Apply a step's normalized result to the working profile, tagging each value
 *  as a calibration result from this step. Returns a NEW profile (input
 *  untouched). Only keys the step is declared to produce are applied. */
export function applyStepResult(
  profile: TemporaryCalibrationProfile,
  stepId: CalibrationId,
  result: StepResultValues,
  opts?: { now?: string }
): TemporaryCalibrationProfile {
  const produced = new Set(WORKFLOW_STEPS[stepId].produces);
  let next = profile;
  for (const key of Object.keys(result) as NormalizedProfileKey[]) {
    if (!produced.has(key)) continue;
    const val = result[key];
    if (typeof val !== 'number') continue;
    next = applyValue(next, key, val, 'calibration_result', { stepId, now: opts?.now });
  }
  return next;
}

// --- staleness / recalibration ---------------------------------------------

/** Fingerprint of just the inputs a step consumes — used to detect when an
 *  upstream result change should invalidate that step's generated job. */
export function inputFingerprintForStep(
  profile: TemporaryCalibrationProfile | undefined,
  stepId: CalibrationId
): string {
  const req = WORKFLOW_STEPS[stepId].requiredInputs as NormalizedProfileKey[];
  const values = profile?.values ?? {};
  const subset: Record<string, number | string | boolean> = {};
  for (const k of req) if (k in values) subset[k] = values[k];
  return fingerprintValues(subset);
}

/** Mark any generated job whose consumed inputs no longer match the current
 *  working profile as `stale`. Mutates the project's `generatedJobs` and returns
 *  the ids that were newly marked stale. A failed job is never marked stale. */
export function markStaleJobs(project: CalibrationProject): string[] {
  const jobs = project.generatedJobs ?? [];
  const staleIds: string[] = [];
  for (const job of jobs) {
    if (job.status === 'stale' || job.status === 'failed') continue;
    const current = inputFingerprintForStep(project.workingProfile, job.stepId);
    if (jobIsStale(job, current)) {
      job.status = 'stale';
      staleIds.push(job.id);
    }
  }
  return staleIds;
}
