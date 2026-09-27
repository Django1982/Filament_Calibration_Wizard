// ---------------------------------------------------------------------------
// Shared helpers for SlicingEngine implementations (Stage 5).
// ---------------------------------------------------------------------------

import type {
  EngineDetectionResult,
  EngineId,
  EngineValidationResult,
  SlicedCalibrationJob,
  SlicedJobInspection,
  SlicingEngineCapabilities
} from '../types';
import type { RawEngineDetection } from '../engineBridge';
import { fromRawCapabilities } from '../engineBridge';

/** Basename of a path, tolerant of both `/` and `\` separators. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Directory portion of a path (everything before the last separator). */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(0, i) : '';
}

/** The `resources/` root that sits beside an Orca executable, matching the
 *  executable's path separator. Windows/Linux layout (the verified install
 *  path); the native side handles the macOS `.app` bundle case for validation. */
export function resourcesRootFromExe(exePath: string): string {
  const dir = dirName(exePath);
  const sep = exePath.includes('\\') ? '\\' : '/';
  return `${dir}${sep}resources`;
}

/** Map a native detection payload to the two split contract results. */
export function splitRawDetection(raw: RawEngineDetection): {
  detection: EngineDetectionResult;
  validation: EngineValidationResult;
  capabilities: SlicingEngineCapabilities;
} {
  const capabilities = fromRawCapabilities(raw.capabilities);
  const engineId = raw.engine_id as EngineId;
  const source = normalizeSource(raw.source);
  return {
    detection: {
      detected: raw.detected,
      engineId,
      displayName: raw.display_name,
      version: raw.version,
      executablePath: raw.executable_path,
      source,
      notes: raw.notes
    },
    validation: {
      valid: raw.valid,
      capabilities: raw.valid ? capabilities : null,
      errors: raw.errors,
      warnings: raw.warnings
    },
    capabilities
  };
}

function normalizeSource(source: string): EngineDetectionResult['source'] {
  switch (source) {
    case 'managed':
    case 'installed':
    case 'manual':
      return source;
    default:
      return 'none';
  }
}

/** Project generation (assembling the Orca project 3mf) lands in Stage 6; the
 *  engine methods that depend on it reject clearly until then rather than
 *  pretending to succeed. */
export function notUntilStage6<T>(method: string): Promise<T> {
  return Promise.reject(
    new Error(`STAGE6_NOT_IMPLEMENTED: ${method} requires Orca project generation (Stage 6)`)
  );
}

/** A SlicedCalibrationJob for an engine/path that produced no sliced artifact. */
export function notSlicedJob(
  preparedProjectId: string,
  stepId: SlicedCalibrationJob['stepId'],
  engineId: EngineId,
  engineVersion: string | null
): SlicedCalibrationJob {
  return {
    preparedProjectId,
    stepId,
    outputGcodePath: null,
    outputArtifactPaths: [],
    engineId,
    engineVersion,
    exitCode: null,
    durationMs: 0,
    logPath: null,
    sliced: false,
    succeeded: false
  };
}

/** Inspect a sliced job's artifact — success is judged from the artifact and
 *  the engine log, never from stdout (which Orca does not expose). Deep g-code
 *  provenance checks (printer/filament values) arrive with Stage 6 generation;
 *  until then those checks report `null` ("not performed") rather than a guess. */
export function inspectSlicedJob(job: SlicedCalibrationJob): SlicedJobInspection {
  const artifactExists = job.outputGcodePath !== null;
  const nonEmpty = job.succeeded; // the runner only reports success on a non-empty g-code
  const findings: string[] = [];
  if (!artifactExists) findings.push('No sliced g-code artifact was produced.');
  else if (!nonEmpty) findings.push('Sliced artifact is empty or the slice did not complete.');
  if (job.logPath) findings.push(`Engine log available at ${job.logPath}`);
  return {
    ok: artifactExists && nonEmpty,
    artifactExists,
    nonEmpty,
    expectedPrinterApplied: null,
    expectedFilamentValuesPresent: null,
    findings
  };
}
