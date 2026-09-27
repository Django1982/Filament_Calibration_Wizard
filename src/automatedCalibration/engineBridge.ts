// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — native engine bridge (Stage 5).
//
// The single boundary between the web-safe engine layer and the native Tauri
// commands in src-tauri/src/slicer_integration/engine.rs. Everything the
// engines do on the desktop goes through here, so a browser/PWA build (no
// __TAURI__) degrades cleanly to the manual-export path instead of throwing.
//
// The bridge is an injectable interface: production uses `nativeEngineBridge`
// (which reaches Tauri lazily through window.__TAURI__), and tests pass a fake
// so they never touch `window` or a real Orca install. Raw payload shapes use
// serde snake_case and mirror the Rust structs exactly.
// ---------------------------------------------------------------------------

import type { EngineId } from './types';

// --- raw payloads (snake_case, mirror engine.rs) ----------------------------

export interface RawEngineCapabilities {
  slice: boolean;
  export_3mf: boolean;
  export_gcode: boolean;
  multi_plate: boolean;
  multi_extruder: boolean;
}

export interface RawEngineDetection {
  engine_id: string;
  detected: boolean;
  display_name: string;
  version: string | null;
  executable_path: string | null;
  source: string;
  checksum_sha256: string | null;
  capabilities: RawEngineCapabilities;
  valid: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
}

export interface RawSliceRun {
  engine_id: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  output_dir: string;
  gcode_path: string | null;
  artifact_paths: string[];
  log_dir: string | null;
  succeeded: boolean;
}

export interface RunSliceArgs {
  engineId: EngineId;
  sessionId: string;
  jobId: string;
  projectFileName: string;
  timeoutMs: number;
  cancellationToken?: string;
}

export interface OpenProjectArgs {
  engineId: EngineId;
  sessionId: string;
  jobId: string;
  projectFileName: string;
}

export interface RevealOutputArgs {
  sessionId: string;
  jobId: string;
}

export interface RawAssembledProject {
  project_file_name: string;
  project_path: string;
  workspace_dir: string;
  config_replaced: boolean;
  entry_count: number;
  warnings: string[];
}

export interface AssembleProjectArgs {
  engineId: EngineId;
  sessionId: string;
  jobId: string;
  /** Source calibration template 3mf (under the user's Orca install). */
  templatePath: string;
  /** The merged project_settings.config text to embed. */
  mergedConfigJson: string;
  outputFileName: string;
}

export interface AssembleTowerArgs {
  sessionId: string;
  jobId: string;
  /** Hottest band temperature (°C) — the bottom of the cut window. */
  startTemp: number;
  /** Coolest band temperature (°C) — the top of the cut window. */
  endTemp: number;
  /** Nozzle diameter (mm); the master tower is scaled by nozzle/0.4. */
  nozzleMm: number;
  /** The merged project_settings.config text to embed. */
  mergedConfigJson: string;
  /** Generated per-band custom_gcode_per_layer.xml (empty string to omit). */
  customGcodeXml: string;
  outputFileName: string;
}

export interface RawFlowObject {
  id: number;
  name: string;
}

export interface FlowObjectOverrides {
  id: number;
  name: string;
  overrides: Record<string, string>;
}

export interface AssembleFlowArgs {
  engineId: EngineId;
  sessionId: string;
  jobId: string;
  /** Source flow-calibration template 3mf (under the user's Orca install). */
  templatePath: string;
  /** The merged project_settings.config text to embed. */
  mergedConfigJson: string;
  /** Every plate object's id/name (echoed back) and computed overrides. */
  objects: FlowObjectOverrides[];
  outputFileName: string;
}

export interface RawResolvedPreset {
  /** Flat combined settings, JSON-serialized (shaped like project_settings.config). */
  settings_json: string;
  printer_model: string | null;
  printer_settings_id: string;
  print_settings_id: string;
  filament_settings_id: string;
  machine_key_count: number;
  process_key_count: number;
  filament_key_count: number;
  warnings: string[];
}

export interface ResolvePresetArgs {
  engineId: EngineId;
  vendor: string;
  /** Exact Orca preset leaf names. */
  machine: string;
  process: string;
  filament: string;
}

export interface RawMachinePreset {
  vendor: string;
  name: string;
  printer_model: string | null;
  nozzle_diameter: string | null;
  default_print_profile: string | null;
  default_filament_profile: string | null;
}

export interface RawFilamentPreset {
  vendor: string;
  name: string;
  filament_type: string | null;
  filament_vendor: string | null;
  /** Machine leaf names this filament declares compatibility with. */
  compatible_printers: string[];
  /** True when compatible_printers is empty — Orca treats it as universal. */
  universal: boolean;
}

/** The native surface the engines depend on. Injectable for tests. */
export interface EngineNativeBridge {
  isDesktop(): boolean;
  detectSlicingEngine(engineId: EngineId, manualExePath?: string): Promise<RawEngineDetection>;
  validateSlicingEngine(engineId: EngineId): Promise<RawEngineDetection>;
  /** Download the pinned managed OrcaSlicer on demand, verify its checksum,
   *  stage it under the managed engines root, and return the fresh detection.
   *  The pin (url + sha256) lives in native code; cancellable via
   *  `cancelCalibrationSlice` with the same token. */
  downloadManagedOrca(cancellationToken?: string): Promise<RawEngineDetection>;
  runCalibrationSlice(args: RunSliceArgs): Promise<RawSliceRun>;
  cancelCalibrationSlice(cancellationToken: string): Promise<boolean>;
  /** Open a sliced job's assembled project in the vetted Orca GUI so the user
   *  can print it / export to SD. Launches the same engine that sliced it. */
  openCalibrationProject(args: OpenProjectArgs): Promise<void>;
  /** Reveal a sliced job's output folder (staged project + g-code) in the OS
   *  file manager, for copying the g-code to an SD card or any other slicer. */
  revealCalibrationOutput(args: RevealOutputArgs): Promise<void>;
  /** Read a template project 3mf's project_settings.config text. */
  readProjectConfig(templatePath: string): Promise<string>;
  /** Stage a complete project 3mf (template + merged config) into the job. */
  assembleCalibrationProject(args: AssembleProjectArgs): Promise<RawAssembledProject>;
  /** Stage a temperature-tower project (STL cut to height + merged config +
   *  per-band custom g-code) into the job. */
  assembleTemperatureTower(args: AssembleTowerArgs): Promise<RawAssembledProject>;
  /** List the id/name of every object on a flow-calibration template plate, so
   *  the caller can compute each object's per-object flow-ratio override. */
  listFlowTestObjects(templatePath: string): Promise<RawFlowObject[]>;
  /** Stage a flow-rate-calibration project (template plate + merged config +
   *  per-object flow-ratio overrides) into the job. */
  assembleFlowTest(args: AssembleFlowArgs): Promise<RawAssembledProject>;
  /** Resolve an Orca printer/process/filament selection (by exact preset names)
   *  into a flat project_settings.config via the vendor `inherits` chains. */
  resolvePresetByNames(args: ResolvePresetArgs): Promise<RawResolvedPreset>;
  /** Enumerate the installed slicer's user-selectable machine presets across
   *  vendors, for mapping a printer selection to (vendor, machine, process). */
  listInstalledMachines(engineId: EngineId): Promise<RawMachinePreset[]>;
  /** Enumerate one vendor's user-selectable filament presets, optionally filtered
   *  to those compatible with a given machine leaf, for material → filament
   *  selection. */
  listVendorFilaments(
    engineId: EngineId,
    vendor: string,
    machineName?: string
  ): Promise<RawFilamentPreset[]>;
}

// --- production implementation (Tauri via window.__TAURI__) ------------------

interface TauriGlobal {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI__?: TauriGlobal };
  return w.__TAURI__ ?? null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri();
  if (!t) throw new Error('NOT_DESKTOP: native engine commands are only available in the desktop app');
  return t.core.invoke<T>(cmd, args);
}

export const nativeEngineBridge: EngineNativeBridge = {
  isDesktop(): boolean {
    return tauri() !== null;
  },
  detectSlicingEngine(engineId, manualExePath) {
    return invoke<RawEngineDetection>('detect_slicing_engine', {
      engineId,
      manualExePath: manualExePath ?? null
    });
  },
  validateSlicingEngine(engineId) {
    return invoke<RawEngineDetection>('validate_slicing_engine', { engineId });
  },
  downloadManagedOrca(cancellationToken) {
    return invoke<RawEngineDetection>('download_managed_orca', {
      cancellationToken: cancellationToken ?? null
    });
  },
  runCalibrationSlice(args) {
    return invoke<RawSliceRun>('run_calibration_slice', {
      engineId: args.engineId,
      sessionId: args.sessionId,
      jobId: args.jobId,
      projectFileName: args.projectFileName,
      timeoutMs: args.timeoutMs,
      cancellationToken: args.cancellationToken ?? null
    });
  },
  cancelCalibrationSlice(cancellationToken) {
    return invoke<boolean>('cancel_calibration_slice', { cancellationToken });
  },
  openCalibrationProject(args) {
    return invoke<void>('open_calibration_project', {
      engineId: args.engineId,
      sessionId: args.sessionId,
      jobId: args.jobId,
      projectFileName: args.projectFileName
    });
  },
  revealCalibrationOutput(args) {
    return invoke<void>('reveal_calibration_output', {
      sessionId: args.sessionId,
      jobId: args.jobId
    });
  },
  readProjectConfig(templatePath) {
    return invoke<string>('read_project_config', { templatePath });
  },
  assembleCalibrationProject(args) {
    return invoke<RawAssembledProject>('assemble_calibration_project', {
      engineId: args.engineId,
      sessionId: args.sessionId,
      jobId: args.jobId,
      templatePath: args.templatePath,
      mergedConfigJson: args.mergedConfigJson,
      outputFileName: args.outputFileName
    });
  },
  assembleTemperatureTower(args) {
    return invoke<RawAssembledProject>('assemble_temperature_tower', {
      sessionId: args.sessionId,
      jobId: args.jobId,
      startTemp: args.startTemp,
      endTemp: args.endTemp,
      nozzleMm: args.nozzleMm,
      mergedConfigJson: args.mergedConfigJson,
      customGcodeXml: args.customGcodeXml,
      outputFileName: args.outputFileName
    });
  },
  listFlowTestObjects(templatePath) {
    return invoke<RawFlowObject[]>('list_flow_test_objects', { templatePath });
  },
  assembleFlowTest(args) {
    return invoke<RawAssembledProject>('assemble_flow_test', {
      engineId: args.engineId,
      sessionId: args.sessionId,
      jobId: args.jobId,
      templatePath: args.templatePath,
      mergedConfigJson: args.mergedConfigJson,
      objectsJson: JSON.stringify(args.objects),
      outputFileName: args.outputFileName
    });
  },
  resolvePresetByNames(args) {
    return invoke<RawResolvedPreset>('resolve_printer_preset', {
      engineId: args.engineId,
      vendor: args.vendor,
      machineName: args.machine,
      processName: args.process,
      filamentName: args.filament
    });
  },
  listInstalledMachines(engineId) {
    return invoke<RawMachinePreset[]>('list_installed_machines', { engineId });
  },
  listVendorFilaments(engineId, vendor, machineName) {
    return invoke<RawFilamentPreset[]>('list_vendor_filaments', {
      engineId,
      vendor,
      machineName: machineName ?? null
    });
  }
};

/** Normalize native snake_case capabilities into the app's camelCase shape. */
export function fromRawCapabilities(c: RawEngineCapabilities) {
  return {
    slice: c.slice,
    export3mf: c.export_3mf,
    exportGcode: c.export_gcode,
    multiPlate: c.multi_plate,
    multiExtruder: c.multi_extruder
  };
}
