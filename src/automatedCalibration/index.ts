// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — public surface (Stage 1).
//
// Contracts + pure helpers only. No engine, session persistence, slicing, or UI
// is exported yet; those arrive in later stages behind the disabled flag.
// ---------------------------------------------------------------------------

export type * from './types';

export {
  createTemporaryProfile,
  applyValue,
  valuesFromSource,
  fingerprintValues,
  jobIsStale,
  isSessionResumable
} from './session';

export {
  emptyEngineCapabilities,
  supported,
  unsupported
} from './capabilities';

export { isAutomatedCalibrationEnabled } from './featureFlag';

export {
  AUTOMATED_SESSION_SCHEMA,
  buildWorkingProfile,
  beginSession,
  canTransition,
  setSessionStatus,
  cancelSession,
  completeSession,
  failSession,
  validateWorkingProfile,
  validateSession,
  loadSessionSafe,
  hasAutomatedSession,
  isResumable,
  resumableSessions
} from './sessionManager';
export type { WorkingProfileSeed, TransitionResult, SafeSessionLoad } from './sessionManager';

export {
  WORKFLOW_STEPS,
  getStepDefinition,
  orderWorkflow,
  missingDependencies,
  stepReadiness,
  validateStepResult,
  applyStepResult,
  inputFingerprintForStep,
  markStaleJobs
} from './workflow';
export type { NormalizedProfileKey, StepResultValues, StepReadiness } from './workflow';

export {
  CALIBRATION_ASSETS,
  getAsset,
  resolveAsset,
  joinResourcePath
} from './assets';
export type { AssetSourceKind, AssetResolutionContext, AssetResolution } from './assets';

export {
  JOB_MANIFEST_SCHEMA,
  WORKSPACE_PREFIX,
  workspaceDirName,
  isPerfectFitWorkspaceName,
  prepareJob
} from './projectPreparation';
export type {
  StagedFileDescriptor,
  JobManifest,
  PreparedJobPlan,
  PrepareJobInput
} from './projectPreparation';

// --- engine layer (Stage 5) ------------------------------------------------

export { nativeEngineBridge, fromRawCapabilities } from './engineBridge';
export type {
  EngineNativeBridge,
  RawEngineDetection,
  RawEngineCapabilities,
  RawSliceRun,
  RunSliceArgs,
  RawAssembledProject,
  AssembleProjectArgs,
  AssembleTowerArgs,
  RawFlowObject,
  FlowObjectOverrides,
  AssembleFlowArgs,
  RawResolvedPreset,
  ResolvePresetArgs,
  RawMachinePreset,
  RawFilamentPreset
} from './engineBridge';

export { mapPrinterToOrca, formatNozzle } from './printerMapping';
export type { OrcaMachineMapping } from './printerMapping';

export {
  MATERIAL_TO_ORCA_TYPES,
  orcaTypesForMaterial,
  fromRawFilament,
  filamentsForMachine,
  filamentsForMaterial,
  selectFilamentForMaterial
} from './filamentSelection';
export type { OrcaFilamentPreset, FilamentSelectionOptions } from './filamentSelection';

export { InstalledOrcaEngine } from './engines/installedOrcaEngine';
export { ManagedOrcaEngine } from './engines/managedOrcaEngine';
export { ManualExportEngine } from './engines/manualExportEngine';
export {
  baseName,
  dirName,
  resourcesRootFromExe,
  inspectSlicedJob,
  notSlicedJob,
  splitRawDetection
} from './engines/engineSupport';

export {
  parseProjectConfig,
  applyPatchesToConfig,
  serializeProjectConfig,
  mergeCalibrationIntoConfig,
  mergeCalibrationIntoProjectConfig
} from './orcaProjectConfig';
export type { ConfigMergeResult, MergedProjectConfig } from './orcaProjectConfig';

export { createEngines, discoverEngines } from './engineRegistry';
export type { EngineStatus, EngineDiagnostics } from './engineRegistry';

export {
  buildTemperatureBands,
  serializeCustomGcodePerLayer,
  generateTemperatureTowerGcode,
  defaultTowerGeometry,
  bandCount,
  towerHeightMm,
  UNSET_EXTRUDER,
  CUSTOM_GCODE_TYPE,
  ORCA_BAND_HEIGHT_MM,
  ORCA_TEMP_STEP_C
} from './temperatureTower';
export type {
  TemperatureBand,
  TemperatureRange,
  TemperatureTowerGeometry
} from './temperatureTower';

export {
  parseObjectFlowModifier,
  computePrintFlowRatio,
  buildFlowObjectOverrides,
  buildFlowPlateOverrides,
  nozzleDependentObjectOverrides,
  FLOW_OBJECT_FIXED_OVERRIDES,
  FLOW_STEP_METHOD
} from './flowCalibration';
export type { FlowTestMethod } from './flowCalibration';
