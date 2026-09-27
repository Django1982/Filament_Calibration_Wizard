// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — Manual Export engine (Stage 5).
//
// The always-available fallback: it needs no external slicer, browser or
// desktop. PerfectFit assembles the calibration project and hands it to the
// user to open and slice in their own slicer. It therefore reports export
// capability but explicitly NOT slice capability — calling `slice()` yields a
// deliberately not-sliced job (never a fake "printer-ready" one), and
// `inspectOutput` says so.
//
// Project assembly itself (resolvePrinterPreset / prepareProject) is Stage 6,
// shared with the Orca engine; those reject clearly until then.
// ---------------------------------------------------------------------------

import type {
  AutomatedCalibrationSession,
  CalibrationStepDefinition,
  EngineDetectionResult,
  EngineValidationResult,
  PreparedCalibrationProject,
  PrinterSelection,
  ResolvedPrinterPreset,
  SliceOptions,
  SlicedCalibrationJob,
  SlicedJobInspection,
  SlicingEngine,
  SlicingEngineCapabilities
} from '../types';
import type { EngineStatus } from '../engineRegistry';
import { notSlicedJob, notUntilStage6 } from './engineSupport';

const ENGINE_ID = 'manual_export' as const;

/** Export-only: prepares a project to open in the user's own slicer; it never
 *  slices, so `slice` is false while `export3mf` is true. */
function manualCapabilities(): SlicingEngineCapabilities {
  return {
    slice: false,
    export3mf: true,
    exportGcode: false,
    multiPlate: false,
    multiExtruder: false
  };
}

export class ManualExportEngine implements SlicingEngine {
  readonly id = ENGINE_ID;
  readonly displayName = 'Manual export';
  readonly version = undefined;

  async detect(): Promise<EngineDetectionResult> {
    // Always "detected": exporting a prepared project needs no external engine.
    return {
      detected: true,
      engineId: ENGINE_ID,
      displayName: this.displayName,
      version: null,
      executablePath: null,
      source: 'none',
      notes: ['Prepares a calibration project for you to open and slice in your own slicer.']
    };
  }

  async validate(): Promise<EngineValidationResult> {
    return { valid: true, capabilities: manualCapabilities(), errors: [], warnings: [] };
  }

  async getCapabilities(): Promise<SlicingEngineCapabilities> {
    return manualCapabilities();
  }

  /** Combined status for the engine-status diagnostics view. */
  async status(): Promise<EngineStatus> {
    return {
      engineId: ENGINE_ID,
      displayName: this.displayName,
      detected: true,
      valid: true,
      version: null,
      source: 'none',
      executablePath: null,
      capabilities: manualCapabilities(),
      errors: [],
      warnings: [],
      notes: ['Always available — no external slicer required.']
    };
  }

  resolvePrinterPreset(_selection: PrinterSelection): Promise<ResolvedPrinterPreset> {
    return notUntilStage6<ResolvedPrinterPreset>('resolvePrinterPreset');
  }

  prepareProject(
    _session: AutomatedCalibrationSession,
    _step: CalibrationStepDefinition,
    _resolvedPreset?: ResolvedPrinterPreset
  ): Promise<PreparedCalibrationProject> {
    return notUntilStage6<PreparedCalibrationProject>('prepareProject');
  }

  /** Manual export never slices: it hands the prepared project to the user. */
  async slice(
    project: PreparedCalibrationProject,
    _options: SliceOptions
  ): Promise<SlicedCalibrationJob> {
    return notSlicedJob(project.id, project.stepId, ENGINE_ID, null);
  }

  async inspectOutput(_job: SlicedCalibrationJob): Promise<SlicedJobInspection> {
    return {
      ok: false,
      artifactExists: false,
      nonEmpty: false,
      expectedPrinterApplied: null,
      expectedFilamentValuesPresent: null,
      findings: ['Manual export produces no sliced artifact — open the prepared project in your slicer.']
    };
  }
}
