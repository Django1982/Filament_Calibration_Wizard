// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — pure session/working-profile helpers.
//
// Small, dependency-free, deterministic functions used across the later stages.
// They do NOT touch storage, the DOM, or the filesystem, so they are safe to
// unit test in the node test environment and safe to run in the browser build.
// ---------------------------------------------------------------------------

import type { CalibrationId } from '../types';
import type {
  CalibrationSessionStatus,
  GeneratedJobRecord,
  ProvenanceSource,
  TemporaryCalibrationProfile
} from './types';

type ProfileValue = number | string | boolean;

/** Create an empty working profile for a project. Immutable inputs; the caller
 *  owns the returned object. */
export function createTemporaryProfile(input: {
  id: string;
  displayName: string;
  projectId: string;
  sourceProfileName?: string;
  now?: string;
}): TemporaryCalibrationProfile {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    displayName: input.displayName,
    createdForProjectId: input.projectId,
    sourceProfileName: input.sourceProfileName,
    values: {},
    provenance: {},
    createdAt: now,
    updatedAt: now
  };
}

/** Return a NEW profile with one value set and its provenance recorded. The
 *  input profile is never mutated. */
export function applyValue(
  profile: TemporaryCalibrationProfile,
  key: string,
  value: ProfileValue,
  source: ProvenanceSource,
  opts?: { stepId?: CalibrationId; now?: string }
): TemporaryCalibrationProfile {
  const now = opts?.now ?? new Date().toISOString();
  return {
    ...profile,
    values: { ...profile.values, [key]: value },
    provenance: {
      ...profile.provenance,
      [key]: { source, stepId: opts?.stepId, updatedAt: now }
    },
    updatedAt: now
  };
}

/** Keys whose current value came from a given provenance source. */
export function valuesFromSource(
  profile: TemporaryCalibrationProfile,
  source: ProvenanceSource
): string[] {
  return Object.keys(profile.provenance)
    .filter((k) => profile.provenance[k].source === source)
    .sort();
}

/** Deterministic fingerprint of a value set — order-independent, so it detects
 *  real value changes rather than key-insertion order. */
export function fingerprintValues(values: Record<string, ProfileValue>): string {
  const keys = Object.keys(values).sort();
  return JSON.stringify(keys.map((k) => [k, values[k]]));
}

/** A generated job is stale when its inputs no longer match the current working
 *  profile (unless it already failed — a failed job is re-run, not "stale"). */
export function jobIsStale(job: GeneratedJobRecord, currentFingerprint: string): boolean {
  if (job.status === 'failed') return false;
  return job.inputFingerprint !== currentFingerprint;
}

const RESUMABLE_STATUSES: ReadonlySet<CalibrationSessionStatus> = new Set([
  'created',
  'in_progress',
  'waiting_for_print',
  'waiting_for_result'
]);

/** Whether a session in this status can be safely reopened and continued. */
export function isSessionResumable(status: CalibrationSessionStatus): boolean {
  return RESUMABLE_STATUSES.has(status);
}
