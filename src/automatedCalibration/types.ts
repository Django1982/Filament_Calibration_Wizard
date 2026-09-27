// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — architectural contracts (Stage 1).
//
// These are the stable interfaces the later stages implement. NOTHING here is
// wired into the running app yet: no session is persisted, no engine runs, no
// slicer profile changes. The automated pipeline stays behind the disabled
// `automatedCalibration` experimental flag until its stages land.
//
// Design decisions this file encodes (see Developer HQ DECISIONS.md, 2026-07-26):
//   * The automated "session" EXTENDS the existing `CalibrationProject` — it is
//     NOT a parallel entity. `AutomatedSessionExtension` below describes the
//     fields Stage 2 folds into `CalibrationProject` (all optional, additive).
//   * Slicing runs Orca as an EXTERNAL executable. PerfectFit assembles a
//     complete Orca project 3mf (model + flat project_settings.config + any
//     per-test custom g-code) and slices it via the CLI. Success is judged from
//     the output artifact + the engine log, never stdout.
//   * Session/profile state lives in IndexedDB (like the rest of the app); only
//     slicer working directories and sliced artifacts live on the filesystem.
// ---------------------------------------------------------------------------

import type { CalibrationId, CalibrationProject } from '../types';
import type { IntegrationSlicerId } from '../slicerIntegration/types';

// --- engine / session identity ---------------------------------------------

/** The interchangeable ways PerfectFit can turn a prepared test into output. */
export type EngineId =
  | 'managed_orca'
  | 'installed_orca'
  | 'manual_export'
  | 'bambu_handoff';

/** A session's chosen slicing path is exactly its engine id. */
export type SlicerMode = EngineId;

export type CalibrationSessionStatus =
  | 'created'
  | 'in_progress'
  | 'waiting_for_print'
  | 'waiting_for_result'
  | 'completed'
  | 'cancelled'
  | 'failed';

// --- temporary working profile ---------------------------------------------

/** Where a working-profile value came from — user input vs inherited vs measured. */
export type ProvenanceSource =
  | 'base_profile'
  | 'printer_default'
  | 'material_default'
  | 'user_input'
  | 'calibration_result';

export interface ProvenanceRecord {
  source: ProvenanceSource;
  /** The calibration step that produced the value, when applicable. */
  stepId?: CalibrationId;
  updatedAt: string;
}

/** A working filament profile a session mutates as results come in. Normalized
 *  PerfectFit keys — slicer-specific key mapping happens through the existing
 *  `src/slicerIntegration/adapters`, never here. */
export interface TemporaryCalibrationProfile {
  id: string;
  displayName: string;
  createdForProjectId: string;
  sourceProfileName?: string;
  values: Record<string, number | string | boolean>;
  provenance: Record<string, ProvenanceRecord>;
  createdAt: string;
  updatedAt: string;
}

// --- generated jobs & warnings ---------------------------------------------

export type GeneratedJobStatus = 'prepared' | 'sliced' | 'failed' | 'stale';

export interface GeneratedJobRecord {
  id: string;
  stepId: CalibrationId;
  createdAt: string;
  engineId: EngineId;
  engineVersion: string | null;
  slicerMode: SlicerMode;
  status: GeneratedJobStatus;
  /** Fingerprint of the working-profile values used, to detect staleness when
   *  an upstream result later changes. */
  inputFingerprint: string;
  /** Path to the sliced artifact, when one was produced. */
  outputPath: string | null;
  sliced: boolean;
  warnings: string[];
}

export interface SessionWarning {
  code: string;
  message: string;
  at: string;
  stepId?: CalibrationId;
}

/**
 * An exact Orca vendor/machine/process/filament choice the user picked by hand
 * (Stage 7 fallback UI), overriding the automatic printer-database →
 * installed-Orca mapping (`mapSelection`/`resolveForMaterial`). Needed when a
 * `PrinterProfile` has no `databasePrinterId` (hand-entered printer) or the
 * automatic mapping can't find/match an installed machine or filament. Once
 * set, every resolve for this session uses `resolvePresetByNames` with these
 * exact names instead of the automatic path.
 */
export interface ManualOrcaPresetSelection {
  vendor: string;
  machine: string;
  process: string;
  filament: string;
}

/**
 * The fields Stage 2 will add to `CalibrationProject` to make it an automated
 * session. Kept as a standalone interface in Stage 1 so the contract is
 * reviewable before the schema migration lands. Every field is optional, so
 * existing projects and the current manual workflow are completely unaffected.
 */
export interface AutomatedSessionExtension {
  /** Per-session schema version, folded into the storage migration in Stage 2. */
  automatedSchemaVersion?: number;
  slicerMode?: SlicerMode;
  sessionStatus?: CalibrationSessionStatus;
  workingProfile?: TemporaryCalibrationProfile;
  generatedJobs?: GeneratedJobRecord[];
  sessionWarnings?: SessionWarning[];
  selectedEngineId?: EngineId;
  /** A hand-picked Orca vendor/machine/process/filament, overriding the
   *  automatic printer-database mapping for every resolve in this session. */
  manualOrcaPreset?: ManualOrcaPresetSelection;
}

/** A `CalibrationProject` once the automated fields are present. */
export type AutomatedCalibrationSession = CalibrationProject & AutomatedSessionExtension;

// --- capability results ----------------------------------------------------

export interface CapabilityResult {
  supported: boolean;
  reasons: string[];
}

export interface SlicingEngineCapabilities {
  slice: boolean;
  export3mf: boolean;
  exportGcode: boolean;
  multiPlate: boolean;
  multiExtruder: boolean;
}

export interface EngineDetectionResult {
  detected: boolean;
  engineId: EngineId;
  displayName: string;
  version: string | null;
  executablePath: string | null;
  source: 'managed' | 'installed' | 'manual' | 'none';
  notes: string[];
}

export interface EngineValidationResult {
  valid: boolean;
  capabilities: SlicingEngineCapabilities | null;
  errors: string[];
  warnings: string[];
}

// --- printer preset resolution ---------------------------------------------

export interface PrinterSelection {
  printerProfileId: string;
  nozzleDiameterMm: number;
  slicer: IntegrationSlicerId;
}

/** A flat, resolved settings object destined for a project 3mf's
 *  `project_settings.config` (no `inherits`). */
export interface ResolvedPrinterPreset {
  settings: Record<string, unknown>;
  printerModel: string | null;
  printerSettingsId: string | null;
  source: 'vendor_profile' | 'installed_slicer' | 'bundled' | 'user';
  warnings: string[];
}

// --- prepared project / sliced job -----------------------------------------

/** A staged, not-yet-sliced calibration workspace. `sliced` is always false by
 *  construction — an unsliced 3MF must never be labeled printer-ready. */
export interface PreparedCalibrationProject {
  id: string;
  projectId: string;
  stepId: CalibrationId;
  /** Directory holding the staged inputs (model + configs + manifest). */
  workspaceDir: string;
  /** The assembled Orca project 3mf path once written, else null. */
  projectFilePath: string | null;
  manifestPath: string;
  sliced: false;
  createdAt: string;
}

export interface SliceOptions {
  outputDir: string;
  timeoutMs: number;
  /** Opaque token the process runner can use to cancel a running slice. */
  cancellationToken?: string;
}

export interface SlicedCalibrationJob {
  preparedProjectId: string;
  stepId: CalibrationId;
  outputGcodePath: string | null;
  outputArtifactPaths: string[];
  engineId: EngineId;
  engineVersion: string | null;
  exitCode: number | null;
  durationMs: number;
  /** Path to the engine's own log (Orca writes to `<datadir>/log/`). */
  logPath: string | null;
  sliced: boolean;
  succeeded: boolean;
}

/** Post-slice validation — success is judged from the artifact + log, never
 *  from the engine's (uncapturable) stdout. */
export interface SlicedJobInspection {
  ok: boolean;
  artifactExists: boolean;
  nonEmpty: boolean;
  /** null when the check could not be performed for this engine/output. */
  expectedPrinterApplied: boolean | null;
  expectedFilamentValuesPresent: boolean | null;
  findings: string[];
}

// --- slicing engine interface ----------------------------------------------

/**
 * A pluggable slicing engine. Implementations: ManagedOrcaEngine,
 * InstalledOrcaEngine, ManualExportEngine, BambuStudioHandoff. Engines are NOT
 * responsible for printer communication — that is a `PrintDestination`.
 */
export interface SlicingEngine {
  readonly id: EngineId;
  readonly displayName: string;
  readonly version?: string;

  detect(): Promise<EngineDetectionResult>;
  validate(): Promise<EngineValidationResult>;
  getCapabilities(): Promise<SlicingEngineCapabilities>;

  resolvePrinterPreset(selection: PrinterSelection): Promise<ResolvedPrinterPreset>;

  /**
   * Assemble a sliceable project for a step. When `resolvedPreset` is supplied
   * the session's calibrated values are merged into THAT (the user's real
   * printer/process/filament, from `resolvePrinterPreset`); otherwise the
   * calibration template's own embedded config is used (correct only when the
   * user prints on the template's printer).
   */
  prepareProject(
    session: AutomatedCalibrationSession,
    step: CalibrationStepDefinition,
    resolvedPreset?: ResolvedPrinterPreset
  ): Promise<PreparedCalibrationProject>;

  slice(
    project: PreparedCalibrationProject,
    options: SliceOptions
  ): Promise<SlicedCalibrationJob>;

  inspectOutput(job: SlicedCalibrationJob): Promise<SlicedJobInspection>;
}

// --- print destinations (separate from slicing) ----------------------------

export interface DestinationCapabilities {
  acceptsSlicedJob: boolean;
  acceptsPreparedProject: boolean;
  opensExternalSlicer: boolean;
  /** Always false for the initial destinations — no direct printer upload yet. */
  sendsToPrinter: boolean;
}

export interface DeliveryResult {
  delivered: boolean;
  destinationId: string;
  /** Where the output landed (a file path) or a description of the handoff. */
  location: string | null;
  opensExternally: boolean;
  warnings: string[];
  error: string | null;
}

/** Where a prepared/sliced job goes. Initial: SaveToFileDestination,
 *  OpenInInstalledSlicerDestination. Future: Moonraker/OctoPrint/PrusaLink. */
export interface PrintDestination {
  readonly id: string;
  readonly displayName: string;
  getCapabilities(): Promise<DestinationCapabilities>;
  deliver(job: SlicedCalibrationJob | PreparedCalibrationProject): Promise<DeliveryResult>;
}

// --- workflow step definition (Stage 3 contract) ---------------------------

/**
 * The richer, dependency-aware step model the Stage 3 workflow engine builds on
 * top of the existing instructional content in `src/data/calibrations.ts`.
 * Interface only in Stage 1 — the registry itself is Stage 3.
 */
export interface CalibrationStepDefinition {
  id: CalibrationId;
  /** Normalized value keys this step needs from earlier steps to prepare. */
  requiredInputs: string[];
  optionalInputs: string[];
  /** Normalized value keys this step's result produces. */
  produces: string[];
  needsSlicing: boolean;
  supportsManualFiles: boolean;
  compatibleSlicers: IntegrationSlicerId[];
  /** Validation ranges for produced values (normalized key → inclusive range). */
  valueRanges: Record<string, { min: number; max: number }>;
  /** Steps whose result change invalidates this step's generated jobs. */
  recalibrationDependsOn: CalibrationId[];
}

// --- calibration asset registry (Stage 4 contract) -------------------------

export type AssetType = 'stl' | '3mf' | 'project-template' | 'generated';

export interface AssetLicenseMetadata {
  /** SPDX id where known, else 'proprietary' / 'unknown'. */
  license: string;
  attribution: string;
  sourceUrl: string | null;
  /** false → link or user-provided only; never redistributed by PerfectFit. */
  redistributable: boolean;
}

export interface AssetCompatibility {
  stepIds: CalibrationId[];
  /** Explicit sizes, or 'scalable' for geometry PerfectFit scales to nozzle. */
  nozzleDiametersMm: number[] | 'scalable';
  requiredSlicerFeatures: string[];
}

export interface CalibrationAssetDefinition {
  id: string;
  version: string;
  displayName: string;
  stepId: CalibrationId;
  assetType: AssetType;
  bundledPath?: string;
  downloadUrl?: string;
  checksumSha256?: string;
  /**
   * Relative path under an installed slicer's resource root (e.g.
   * 'calib/temperature_tower/temperature_tower.stl'). Lets PerfectFit reference
   * the calibration model shipped inside the user's own Orca install instead of
   * redistributing it — the preferred, license-clean source.
   */
  slicerResourceRelPath?: string;
  /**
   * True when the geometry alone is not a complete test: PerfectFit must inject
   * test parameters / per-layer custom g-code (temp-tower temperatures, flow
   * modifiers, the volumetric-speed ramp) when assembling the project.
   */
  requiresParameterization?: boolean;
  license: AssetLicenseMetadata;
  compatibility: AssetCompatibility;
}
