// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — project preparation (Stage 4).
//
// Combines a resolved calibration asset + printer/nozzle selection + the
// session's working-profile values + step parameters into an UNSLICED job plan:
// a manifest describing every input, plus the list of files a workspace will
// contain. No slicing happens here and nothing is ever labeled printer-ready —
// `sliced` is `false` by construction. Physical staging (copying the model,
// writing project_settings.config) happens in the engine stage on the Rust side;
// this module produces the deterministic plan that stage will execute.
//
// Pure module (no fs). Gated behind the disabled flag.
// ---------------------------------------------------------------------------

import type { CalibrationId, CalibrationProject } from '../types';
import type { AssetLicenseMetadata, PrinterSelection, SlicerMode } from './types';
import { inputFingerprintForStep } from './workflow';
import { type AssetResolutionContext, type AssetSourceKind, resolveAsset } from './assets';

export const JOB_MANIFEST_SCHEMA = 1;

/** Prefix marking a directory as PerfectFit-owned, so a cleaner can only ever
 *  remove our own workspaces. */
export const WORKSPACE_PREFIX = 'pf-job';

export interface StagedFileDescriptor {
  role: 'model' | 'project-config' | 'custom-gcode' | 'manifest';
  fileName: string;
  /** Where the bytes come from; null when generated at stage time. */
  sourceKind: AssetSourceKind | 'generated';
  sourceLocation: string | null;
}

export interface JobManifest {
  schemaVersion: number;
  jobId: string;
  projectId: string;
  stepId: CalibrationId;
  createdAt: string;
  slicerMode: SlicerMode;
  asset: {
    assetId: string | null;
    sourceKind: AssetSourceKind | null;
    location: string | null;
    license: AssetLicenseMetadata | null;
    requiresParameterization: boolean;
  };
  printerSelection: PrinterSelection;
  nozzleDiameterMm: number;
  /** Snapshot of the normalized working-profile values baked into this job. */
  appliedValues: Record<string, number | string | boolean>;
  /** Fingerprint of the inputs this job consumed, for staleness detection. */
  inputFingerprint: string;
  /** Test-specific parameters (tower ranges, steps) applied during staging. */
  stepParameters: Record<string, number | string | boolean>;
  /** Always false — a prepared workspace is never sliced/printer-ready. */
  sliced: false;
  warnings: string[];
}

export interface PreparedJobPlan {
  ok: boolean;
  manifest: JobManifest;
  workspaceDirName: string;
  plannedFiles: StagedFileDescriptor[];
  warnings: string[];
}

/** Small deterministic hash (djb2) for short, stable workspace names. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Deterministic, filesystem-safe workspace directory name for a job. The same
 *  project+step+inputs always yields the same name, so re-preparing an unchanged
 *  job is idempotent and a changed input produces a distinct workspace. */
export function workspaceDirName(projectId: string, stepId: CalibrationId, inputFingerprint: string): string {
  return `${WORKSPACE_PREFIX}_${sanitizeSegment(projectId)}_${sanitizeSegment(stepId)}_${shortHash(inputFingerprint)}`;
}

/** Guard used by the (future) cleaner: only names we produced may be removed. */
export function isPerfectFitWorkspaceName(name: string): boolean {
  return new RegExp(`^${WORKSPACE_PREFIX}_[A-Za-z0-9_-]+$`).test(name);
}

export interface PrepareJobInput {
  project: CalibrationProject;
  stepId: CalibrationId;
  slicerMode: SlicerMode;
  printerSelection: PrinterSelection;
  nozzleDiameterMm: number;
  assetContext?: AssetResolutionContext;
  stepParameters?: Record<string, number | string | boolean>;
  jobId: string;
  now?: string;
}

/**
 * Build the unsliced preparation plan for one calibration test. Resolves the
 * asset, snapshots the working-profile values, and lists the files the workspace
 * will hold (model, the project_settings.config to be generated, optional custom
 * g-code, and the manifest itself). Never slices; `sliced` is always false.
 */
export function prepareJob(input: PrepareJobInput): PreparedJobPlan {
  const now = input.now ?? new Date().toISOString();
  const asset = resolveAsset(input.stepId, input.assetContext);
  const appliedValues = { ...(input.project.workingProfile?.values ?? {}) };
  const inputFingerprint = inputFingerprintForStep(input.project.workingProfile, input.stepId);
  const warnings = [...asset.warnings];
  if (!asset.available && asset.remedy) warnings.push(asset.remedy);

  const manifest: JobManifest = {
    schemaVersion: JOB_MANIFEST_SCHEMA,
    jobId: input.jobId,
    projectId: input.project.id,
    stepId: input.stepId,
    createdAt: now,
    slicerMode: input.slicerMode,
    asset: {
      assetId: asset.assetId,
      sourceKind: asset.sourceKind,
      location: asset.location,
      license: asset.license,
      requiresParameterization: asset.requiresParameterization
    },
    printerSelection: input.printerSelection,
    nozzleDiameterMm: input.nozzleDiameterMm,
    appliedValues,
    inputFingerprint,
    stepParameters: input.stepParameters ?? {},
    sliced: false,
    warnings
  };

  const plannedFiles: StagedFileDescriptor[] = [];
  if (asset.sourceKind && asset.sourceKind !== 'generated' && asset.location) {
    const ext = asset.location.toLowerCase().endsWith('.3mf') ? '3mf' : 'stl';
    plannedFiles.push({
      role: 'model',
      fileName: `model.${ext}`,
      sourceKind: asset.sourceKind,
      sourceLocation: asset.location
    });
  }
  // project_settings.config and any custom g-code are generated during staging.
  plannedFiles.push({ role: 'project-config', fileName: 'project_settings.config', sourceKind: 'generated', sourceLocation: null });
  if (asset.requiresParameterization) {
    plannedFiles.push({ role: 'custom-gcode', fileName: 'custom_gcode_per_layer.xml', sourceKind: 'generated', sourceLocation: null });
  }
  plannedFiles.push({ role: 'manifest', fileName: 'job-manifest.json', sourceKind: 'generated', sourceLocation: null });

  return {
    ok: asset.available,
    manifest,
    workspaceDirName: workspaceDirName(input.project.id, input.stepId, inputFingerprint),
    plannedFiles,
    warnings
  };
}
