import { describe, it, expect } from 'vitest';
import {
  InstalledOrcaEngine,
  ManagedOrcaEngine,
  ManualExportEngine,
  discoverEngines,
  splitRawDetection,
  fromRawCapabilities,
  getStepDefinition,
  buildWorkingProfile,
  applyStepResult,
  mapPrinterToOrca
} from '../../src/automatedCalibration';
import type {
  EngineNativeBridge,
  RawEngineDetection,
  RawSliceRun,
  RunSliceArgs,
  AssembleProjectArgs,
  AssembleTowerArgs,
  AssembleFlowArgs
} from '../../src/automatedCalibration';
import type { PreparedCalibrationProject, AutomatedCalibrationSession } from '../../src/automatedCalibration';

// --- fixtures ---------------------------------------------------------------

const VALID_ORCA: RawEngineDetection = {
  engine_id: 'installed_orca',
  detected: true,
  display_name: 'Installed OrcaSlicer',
  version: '2.4.2',
  executable_path: 'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
  source: 'installed',
  checksum_sha256: 'abc123',
  capabilities: { slice: true, export_3mf: true, export_gcode: true, multi_plate: false, multi_extruder: false },
  valid: true,
  errors: [],
  warnings: ['Multi-plate and multi-extruder support not verified without a trial slice'],
  notes: []
};

const INVALID_ORCA: RawEngineDetection = {
  ...VALID_ORCA,
  checksum_sha256: null,
  capabilities: { slice: false, export_3mf: false, export_gcode: false, multi_plate: false, multi_extruder: false },
  valid: false,
  errors: ['resources/calib not found — calibration models are missing'],
  warnings: []
};

const SLICE_OK: RawSliceRun = {
  engine_id: 'installed_orca',
  exit_code: 0,
  duration_ms: 4200,
  timed_out: false,
  cancelled: false,
  output_dir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\out',
  gcode_path: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\out\\plate_1.gcode',
  artifact_paths: ['C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\out\\plate_1.gcode'],
  log_dir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\datadir\\log',
  succeeded: true
};

const PREPARED: PreparedCalibrationProject = {
  id: 'job-1',
  projectId: 'sess-1',
  stepId: 'pressure-advance',
  workspaceDir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\workspace',
  projectFilePath: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\workspace\\project.3mf',
  manifestPath: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-1\\workspace\\job-manifest.json',
  sliced: false,
  createdAt: '2026-07-26T00:00:00Z'
};

const ASSEMBLED = {
  project_file_name: 'project.3mf',
  project_path: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-x\\workspace\\project.3mf',
  workspace_dir: 'C:\\PerfectFit\\sessions\\sess-1\\jobs\\job-x\\workspace',
  config_replaced: true,
  entry_count: 12,
  warnings: []
};

// A template project_settings.config the fake bridge hands back.
const TEMPLATE_CONFIG = JSON.stringify({
  pressure_advance: ['0.02'],
  enable_pressure_advance: ['0'],
  filament_flow_ratio: ['1'],
  printer_settings_id: 'Bambu Lab N1 0.4 nozzle'
});

function fakeBridge(overrides: Partial<EngineNativeBridge> = {}): EngineNativeBridge {
  return {
    isDesktop: () => true,
    detectSlicingEngine: async () => VALID_ORCA,
    validateSlicingEngine: async () => VALID_ORCA,
    downloadManagedOrca: async () => ({ ...VALID_ORCA, engine_id: 'managed_orca', display_name: 'Managed OrcaSlicer', source: 'managed' }),
    runCalibrationSlice: async () => SLICE_OK,
    cancelCalibrationSlice: async () => true,
    openCalibrationProject: async () => {},
    revealCalibrationOutput: async () => {},
    readProjectConfig: async () => TEMPLATE_CONFIG,
    assembleCalibrationProject: async () => ASSEMBLED,
    assembleTemperatureTower: async () => ASSEMBLED,
    listFlowTestObjects: async () => FLOW_PASS1_OBJECTS,
    assembleFlowTest: async () => ASSEMBLED,
    resolvePresetByNames: async () => RESOLVED_PRESET,
    listInstalledMachines: async () => INSTALLED_MACHINES,
    listVendorFilaments: async () => INSTALLED_FILAMENTS,
    ...overrides
  };
}

const INSTALLED_FILAMENTS = [
  {
    vendor: 'BBL',
    name: 'Bambu PLA Basic @BBL X1C',
    filament_type: 'PLA',
    filament_vendor: 'Bambu',
    compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    universal: false
  },
  {
    vendor: 'BBL',
    name: 'Bambu PLA Silk @BBL X1C',
    filament_type: 'PLA',
    filament_vendor: 'Bambu',
    compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    universal: false
  },
  {
    vendor: 'BBL',
    name: 'Generic PETG @BBL X1C',
    filament_type: 'PETG',
    filament_vendor: 'Generic',
    compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    universal: false
  },
  {
    vendor: 'BBL',
    name: 'Bambu PETG @BBL A1',
    filament_type: 'PETG',
    filament_vendor: 'Bambu',
    compatible_printers: ['Bambu Lab A1 0.4 nozzle'],
    universal: false
  }
];

const INSTALLED_MACHINES = [
  {
    vendor: 'BBL',
    name: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printer_model: 'Bambu Lab X1 Carbon',
    nozzle_diameter: '0.4',
    default_print_profile: '0.20mm Standard @BBL X1C',
    default_filament_profile: null
  },
  {
    vendor: 'BBL',
    name: 'Bambu Lab X1 Carbon 0.6 nozzle',
    printer_model: 'Bambu Lab X1 Carbon',
    nozzle_diameter: '0.6',
    default_print_profile: '0.30mm Standard @BBL X1C 0.6 nozzle',
    default_filament_profile: null
  }
];

const FLOW_PASS1_OBJECTS = [
  { id: 1, name: 'flowrate_0' },
  { id: 3, name: 'flowrate_10' },
  { id: 11, name: 'flowrate_m10' }
];

const RESOLVED_PRESET = {
  settings_json: JSON.stringify({
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    nozzle_diameter: ['0.4'],
    filament_flow_ratio: ['1']
  }),
  printer_model: 'Bambu Lab X1 Carbon',
  printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
  print_settings_id: '0.20mm Standard @BBL X1C',
  filament_settings_id: 'Bambu PLA Basic @BBL X1C',
  machine_key_count: 200,
  process_key_count: 100,
  filament_key_count: 64,
  warnings: []
};

// --- capability mapping -----------------------------------------------------

describe('capability mapping', () => {
  it('maps snake_case native capabilities to camelCase', () => {
    const caps = fromRawCapabilities(VALID_ORCA.capabilities);
    expect(caps).toEqual({ slice: true, export3mf: true, exportGcode: true, multiPlate: false, multiExtruder: false });
  });

  it('splits a raw detection into detection + validation, nulling caps when invalid', () => {
    expect(splitRawDetection(VALID_ORCA).validation.capabilities).not.toBeNull();
    expect(splitRawDetection(INVALID_ORCA).validation.capabilities).toBeNull();
    expect(splitRawDetection(VALID_ORCA).detection.source).toBe('installed');
  });
});

// --- ManualExportEngine -----------------------------------------------------

describe('ManualExportEngine', () => {
  const engine = new ManualExportEngine();

  it('is always detected and valid, export-only (never slices)', async () => {
    expect((await engine.detect()).detected).toBe(true);
    const v = await engine.validate();
    expect(v.valid).toBe(true);
    const caps = await engine.getCapabilities();
    expect(caps.export3mf).toBe(true);
    expect(caps.slice).toBe(false);
  });

  it('slice() returns a deliberately not-sliced job, never printer-ready', async () => {
    const job = await engine.slice(PREPARED, { outputDir: 'x', timeoutMs: 1000 });
    expect(job.sliced).toBe(false);
    expect(job.succeeded).toBe(false);
    expect(job.outputGcodePath).toBeNull();
    expect(job.engineId).toBe('manual_export');
    const inspection = await engine.inspectOutput(job);
    expect(inspection.ok).toBe(false);
    expect(inspection.findings.join(' ')).toMatch(/open the prepared project/i);
  });
});

// --- InstalledOrcaEngine (desktop) ------------------------------------------

describe('InstalledOrcaEngine (desktop)', () => {
  it('detects and validates from the native payload', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const d = await engine.detect();
    expect(d.detected).toBe(true);
    expect(d.version).toBe('2.4.2');
    expect(d.executablePath).toContain('orca-slicer.exe');
    expect(d.source).toBe('installed');
    const caps = await engine.getCapabilities();
    expect(caps.slice).toBe(true);
    expect(engine.version).toBe('2.4.2');
  });

  it('slice() maps prepared-project ids onto the managed job layout', async () => {
    let captured: RunSliceArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        runCalibrationSlice: async (args) => {
          captured = args;
          return SLICE_OK;
        }
      })
    );
    await engine.detect(); // populate version
    const job = await engine.slice(PREPARED, { outputDir: 'out', timeoutMs: 60_000, cancellationToken: 'tok-1' });

    expect(captured).not.toBeNull();
    expect(captured!.sessionId).toBe('sess-1'); // projectId → session
    expect(captured!.jobId).toBe('job-1'); // prepared id → job
    expect(captured!.projectFileName).toBe('project.3mf'); // basename of the 3mf
    expect(captured!.cancellationToken).toBe('tok-1');

    expect(job.succeeded).toBe(true);
    expect(job.sliced).toBe(true);
    expect(job.outputGcodePath).toContain('plate_1.gcode');
    expect(job.durationMs).toBe(4200);
    expect(job.exitCode).toBe(0);
    expect(job.engineVersion).toBe('2.4.2');
    expect(job.logPath).toContain('log');

    const inspection = await engine.inspectOutput(job);
    expect(inspection.ok).toBe(true);
    expect(inspection.artifactExists).toBe(true);
    // Deep g-code provenance is Stage 6 — reported as "not performed", not guessed.
    expect(inspection.expectedPrinterApplied).toBeNull();
  });

  it('does not slice when no project 3mf is assembled', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const job = await engine.slice({ ...PREPARED, projectFilePath: null }, { outputDir: 'o', timeoutMs: 1000 });
    expect(job.succeeded).toBe(false);
    expect(job.sliced).toBe(false);
  });

  it('resolves a preset by exact Orca names into a flat config', async () => {
    let captured: { vendor: string; machine: string; process: string; filament: string } | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        resolvePresetByNames: async (a) => {
          captured = a;
          return RESOLVED_PRESET;
        }
      })
    );
    const preset = await engine.resolvePresetByNames({
      vendor: 'BBL',
      machine: 'Bambu Lab X1 Carbon 0.4 nozzle',
      process: '0.20mm Standard @BBL X1C',
      filament: 'Bambu PLA Basic @BBL X1C'
    });
    expect(captured!.vendor).toBe('BBL');
    expect(preset.printerModel).toBe('Bambu Lab X1 Carbon');
    expect(preset.source).toBe('vendor_profile');
    expect((preset.settings as Record<string, unknown>).nozzle_diameter).toEqual(['0.4']);
    expect(preset.printerSettingsId).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
  });

  it('maps a printer-DB selection to the installed Orca machine + process', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const mapping = await engine.mapSelection({
      printerProfileId: 'bambu-lab-x1-carbon',
      nozzleDiameterMm: 0.4,
      slicer: 'orca'
    });
    expect(mapping.vendor).toBe('BBL');
    expect(mapping.machineName).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(mapping.process).toBe('0.20mm Standard @BBL X1C');
  });

  it('resolveForPrinter resolves the full config given a filament', async () => {
    let captured: { vendor: string; machine: string; process: string; filament: string } | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        resolvePresetByNames: async (a) => {
          captured = a;
          return RESOLVED_PRESET;
        }
      })
    );
    const preset = await engine.resolveForPrinter(
      { printerProfileId: 'bambu-lab-x1-carbon', nozzleDiameterMm: 0.4, slicer: 'orca' },
      'Bambu PLA Basic @BBL X1C'
    );
    expect(captured!.machine).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(captured!.process).toBe('0.20mm Standard @BBL X1C');
    expect(captured!.filament).toBe('Bambu PLA Basic @BBL X1C');
    expect(preset.printerModel).toBe('Bambu Lab X1 Carbon');
  });

  it('lists filaments compatible with a printer selection', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    const filaments = await engine.listFilamentsForSelection({
      printerProfileId: 'bambu-lab-x1-carbon',
      nozzleDiameterMm: 0.4,
      slicer: 'orca'
    });
    // fake bridge returns the raw list; the engine normalizes to camelCase
    expect(filaments.map((f) => f.name)).toContain('Bambu PLA Basic @BBL X1C');
    expect(filaments[0].filamentType).toBe('PLA');
  });

  it('resolveForMaterial picks a filament for the material and resolves end-to-end', async () => {
    let captured: { vendor: string; machine: string; process: string; filament: string } | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        resolvePresetByNames: async (a) => {
          captured = a;
          return RESOLVED_PRESET;
        }
      })
    );
    const preset = await engine.resolveForMaterial(
      { printerProfileId: 'bambu-lab-x1-carbon', nozzleDiameterMm: 0.4, slicer: 'orca' },
      'PLA'
    );
    // prefers the generic "Basic" PLA over the "Silk" specialty variant
    expect(captured!.filament).toBe('Bambu PLA Basic @BBL X1C');
    expect(captured!.machine).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(preset.printerModel).toBe('Bambu Lab X1 Carbon');
  });

  it('resolveForMaterial throws FILAMENT_NOT_FOUND when no material matches', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await expect(
      engine.resolveForMaterial(
        { printerProfileId: 'bambu-lab-x1-carbon', nozzleDiameterMm: 0.4, slicer: 'orca' },
        'PPS'
      )
    ).rejects.toThrow(/FILAMENT_NOT_FOUND/);
  });

  it('throws PRINTER_NOT_IN_ORCA when the printer/nozzle is not installed', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await expect(
      engine.mapSelection({ printerProfileId: 'bambu-lab-x1-carbon', nozzleDiameterMm: 0.8, slicer: 'orca' })
    ).rejects.toThrow(/PRINTER_NOT_IN_ORCA/);
  });

  it('resolvePrinterPreset maps then asks for a filament (contract entry)', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await expect(
      engine.resolvePrinterPreset({ printerProfileId: 'bambu-lab-x1-carbon', nozzleDiameterMm: 0.4, slicer: 'orca' })
    ).rejects.toThrow(/FILAMENT_SELECTION_REQUIRED/);
  });
});

describe('mapPrinterToOrca (pure)', () => {
  it('matches on exact model + nozzle and requires a default process', () => {
    const machines = [
      { vendor: 'BBL', name: 'A 0.4 nozzle', printer_model: 'A', nozzle_diameter: '0.4', default_print_profile: 'P', default_filament_profile: null },
      { vendor: 'BBL', name: 'A 0.6 nozzle', printer_model: 'A', nozzle_diameter: '0.6', default_print_profile: null, default_filament_profile: null }
    ];
    expect(mapPrinterToOrca('A', 0.4, machines)?.machineName).toBe('A 0.4 nozzle');
    // 0.6 has no default process → no usable match
    expect(mapPrinterToOrca('A', 0.6, machines)).toBeNull();
    // unknown model
    expect(mapPrinterToOrca('B', 0.4, machines)).toBeNull();
  });
});

// --- InstalledOrcaEngine.prepareProject (project-template assembly) ----------

function paSession(): AutomatedCalibrationSession {
  let wp = buildWorkingProfile({ projectId: 'sess-1', displayName: 'w' });
  wp = applyStepResult(wp, 'pressure-advance', { pressureAdvance: 0.03 });
  return {
    id: 'sess-1',
    workingProfile: wp,
    steps: { 'pressure-advance': { status: 'completed' } },
    finals: { pressureAdvance: 0.03 }
  } as unknown as AutomatedCalibrationSession;
}

describe('InstalledOrcaEngine.prepareProject', () => {
  it('assembles a complete project from a project-template asset', async () => {
    let capturedRead: string | null = null;
    let capturedAssemble: AssembleProjectArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        readProjectConfig: async (p) => {
          capturedRead = p;
          return TEMPLATE_CONFIG;
        },
        assembleCalibrationProject: async (a) => {
          capturedAssemble = a;
          return ASSEMBLED;
        }
      })
    );
    await engine.detect();
    const step = getStepDefinition('pressure-advance')!;
    const prepared = await engine.prepareProject(paSession(), step);

    expect(prepared.stepId).toBe('pressure-advance');
    expect(prepared.projectId).toBe('sess-1');
    expect(prepared.projectFilePath).toContain('project.3mf');
    expect(prepared.sliced).toBe(false);

    // template read from the resolved installed-slicer resource path
    expect(capturedRead).toContain('pa_pattern.3mf');
    // the merged config carried the calibrated PA value + its companion enable
    expect(capturedAssemble).not.toBeNull();
    const merged = JSON.parse(capturedAssemble!.mergedConfigJson);
    expect(merged.pressure_advance).toEqual(['0.03']);
    expect(merged.enable_pressure_advance).toEqual(['1']);
    expect(capturedAssemble!.outputFileName).toBe('project.3mf');
    expect(capturedAssemble!.sessionId).toBe('sess-1');
  });

  it('merges calibrated values into the RESOLVED printer config when given a preset', async () => {
    let capturedAssemble: AssembleProjectArgs | null = null;
    let readCalled = false;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        readProjectConfig: async () => {
          readCalled = true;
          return TEMPLATE_CONFIG;
        },
        assembleCalibrationProject: async (a) => {
          capturedAssemble = a;
          return ASSEMBLED;
        }
      })
    );
    await engine.detect();
    const step = getStepDefinition('pressure-advance')!;
    const resolvedPreset = {
      settings: {
        printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
        nozzle_diameter: ['0.4'],
        pressure_advance: ['0.02'],
        enable_pressure_advance: ['0'],
        filament_flow_ratio: ['0.98']
      } as Record<string, unknown>,
      printerModel: 'Bambu Lab X1 Carbon',
      printerSettingsId: 'Bambu Lab X1 Carbon 0.4 nozzle',
      source: 'vendor_profile' as const,
      warnings: []
    };
    const prepared = await engine.prepareProject(paSession(), step, resolvedPreset);

    // the template's own config was NOT read — the resolved config is the base
    expect(readCalled).toBe(false);
    const merged = JSON.parse(capturedAssemble!.mergedConfigJson);
    // resolved printer identity is preserved (X1C, not the template's N1)
    expect(merged.printer_settings_id).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(merged.nozzle_diameter).toEqual(['0.4']);
    // and the session's calibrated PA value is merged in
    expect(merged.pressure_advance).toEqual(['0.03']);
    expect(merged.enable_pressure_advance).toEqual(['1']);
    expect(prepared.sliced).toBe(false);
  });

  it('falls back to the template config (template printer) when no preset is given', async () => {
    let capturedAssemble: AssembleProjectArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        assembleCalibrationProject: async (a) => {
          capturedAssemble = a;
          return ASSEMBLED;
        }
      })
    );
    await engine.detect();
    const step = getStepDefinition('pressure-advance')!;
    await engine.prepareProject(paSession(), step);
    const merged = JSON.parse(capturedAssemble!.mergedConfigJson);
    // template config carries the N1 printer
    expect(merged.printer_settings_id).toBe('Bambu Lab N1 0.4 nozzle');
    expect(merged.pressure_advance).toEqual(['0.03']);
  });

  it('rejects a step that still needs parameterized generation (retraction)', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await engine.detect();
    const step = getStepDefinition('retraction')!;
    await expect(engine.prepareProject(paSession(), step)).rejects.toThrow(/UNSUPPORTED_ASSET/);
  });

  it('refuses to assemble off the desktop', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge({ isDesktop: () => false }));
    const step = getStepDefinition('pressure-advance')!;
    await expect(engine.prepareProject(paSession(), step)).rejects.toThrow(/NOT_DESKTOP/);
  });
});

// --- InstalledOrcaEngine.prepareProject (temperature tower, STL) -------------

function tempSession(): AutomatedCalibrationSession {
  const wp = buildWorkingProfile({ projectId: 'sess-1', displayName: 'w' });
  return {
    id: 'sess-1',
    filament: { material: 'PLA', manufacturer: '', productLine: '', color: '', diameter: 1.75, startingProfile: '' },
    workingProfile: wp,
    steps: {},
    finals: {}
  } as unknown as AutomatedCalibrationSession;
}

const RESOLVED_FOR_TOWER = {
  settings: {
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    layer_height: '0.2',
    nozzle_diameter: ['0.4'],
    nozzle_temperature: ['200', '200'],
    nozzle_temperature_initial_layer: ['200', '200']
  } as Record<string, unknown>,
  printerModel: 'Bambu Lab X1 Carbon',
  printerSettingsId: 'Bambu Lab X1 Carbon 0.4 nozzle',
  source: 'vendor_profile' as const,
  warnings: []
};

describe('InstalledOrcaEngine.prepareProject (temperature tower)', () => {
  it('passes the temp window + nozzle, sets start temp, and injects per-band M104', async () => {
    let captured: AssembleTowerArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        assembleTemperatureTower: async (a) => {
          captured = a;
          return ASSEMBLED;
        }
      })
    );
    await engine.detect();
    const step = getStepDefinition('temperature')!;
    const prepared = await engine.prepareProject(tempSession(), step, RESOLVED_FOR_TOWER);

    expect(prepared.stepId).toBe('temperature');
    expect(prepared.projectFilePath).toContain('project.3mf');
    expect(captured).not.toBeNull();
    // PLA towerRange 230->190 => the native side cuts that window of the bundled
    // master; the engine passes the endpoints + nozzle (0.4 default -> scale 1).
    expect(captured!.startTemp).toBe(230);
    expect(captured!.endTemp).toBe(190);
    expect(captured!.nozzleMm).toBe(0.4);
    // per-band changes injected: 225 at the first boundary, 190 at the top
    expect(captured!.customGcodeXml).toContain('M104 S225');
    expect(captured!.customGcodeXml).toContain('M104 S190');
    // start temp (230) written into both temperature keys, per-slot length kept
    const cfg = JSON.parse(captured!.mergedConfigJson);
    expect(cfg.nozzle_temperature).toEqual(['230', '230']);
    expect(cfg.nozzle_temperature_initial_layer).toEqual(['230', '230']);
  });

  it('requires a resolved preset (the STL carries no config)', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await engine.detect();
    const step = getStepDefinition('temperature')!;
    await expect(engine.prepareProject(tempSession(), step)).rejects.toThrow(/RESOLVED_PRESET_REQUIRED/);
  });
});

// --- InstalledOrcaEngine.prepareProject (flow-rate calibration, 3mf) ---------

const RESOLVED_FOR_FLOW = {
  settings: {
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    nozzle_diameter: ['0.4'],
    filament_flow_ratio: ['0.95'],
    initial_layer_print_height: '0.2'
  } as Record<string, unknown>,
  printerModel: 'Bambu Lab X1 Carbon',
  printerSettingsId: 'Bambu Lab X1 Carbon 0.4 nozzle',
  source: 'vendor_profile' as const,
  warnings: []
};

describe('InstalledOrcaEngine.prepareProject (flow-rate calibration)', () => {
  it('computes a per-object print_flow_ratio from each object name and the resolved baseline', async () => {
    let captured: AssembleFlowArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        listFlowTestObjects: async () => FLOW_PASS1_OBJECTS,
        assembleFlowTest: async (a) => {
          captured = a;
          return ASSEMBLED;
        }
      })
    );
    await engine.detect();
    const step = getStepDefinition('flow-pass1')!;
    const prepared = await engine.prepareProject(tempSession(), step, RESOLVED_FOR_FLOW);

    expect(prepared.stepId).toBe('flow-pass1');
    expect(captured).not.toBeNull();
    expect(captured!.templatePath).toBeTruthy();
    expect(captured!.objects).toHaveLength(3);

    const byId = new Map(captured!.objects.map((o) => [o.id, o]));
    // flowrate_0: percent formula, modifier 0 -> 1 + 0/100 = 1
    expect(byId.get(1)!.overrides.print_flow_ratio).toBe('1');
    // flowrate_10: modifier +10 -> 1 + 10/100 = 1.1
    expect(byId.get(3)!.overrides.print_flow_ratio).toBe('1.1');
    // flowrate_m10: modifier -10 -> 1 - 10/100 = 0.9
    expect(byId.get(11)!.overrides.print_flow_ratio).toBe('0.9');
    // fixed per-object overrides present on every object
    expect(byId.get(1)!.overrides.sparse_infill_density).toBe('35%');
    expect(byId.get(1)!.overrides.top_surface_pattern).toBe('archimedeanchords');
    // nozzle-dependent line width (0.4 * 1.2)
    expect(byId.get(1)!.overrides.top_surface_line_width).toBe('0.48');

    // plate-level overrides merged into the config (0.4mm nozzle -> 0.2mm layer)
    const cfg = JSON.parse(captured!.mergedConfigJson);
    expect(cfg.layer_height).toBe('0.2');
    expect(cfg.reduce_crossing_wall).toBe('1');
    // A preset with no bed_exclude_area gets a minimal corner exclusion so
    // OrcaSlicer's conflict checker doesn't reject the tight plate (-101).
    expect(cfg.bed_exclude_area).toEqual(['0x0', '1x0', '1x1', '0x1']);
  });

  it('keeps a preset\'s own bed_exclude_area instead of overriding it', async () => {
    let captured: AssembleFlowArgs | null = null;
    const engine = new InstalledOrcaEngine(
      fakeBridge({
        listFlowTestObjects: async () => FLOW_PASS1_OBJECTS,
        assembleFlowTest: async (a) => {
          captured = a;
          return ASSEMBLED;
        }
      })
    );
    await engine.detect();
    const step = getStepDefinition('flow-pass1')!;
    const withExclusion = {
      ...RESOLVED_FOR_FLOW,
      settings: { ...RESOLVED_FOR_FLOW.settings, bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'] }
    };
    await engine.prepareProject(tempSession(), step, withExclusion);
    const cfg = JSON.parse(captured!.mergedConfigJson);
    expect(cfg.bed_exclude_area).toEqual(['0x0', '18x0', '18x28', '0x28']);
  });

  it('requires a resolved preset (the template plate has no embedded config)', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await engine.detect();
    const step = getStepDefinition('flow-pass1')!;
    await expect(engine.prepareProject(tempSession(), step)).rejects.toThrow(/RESOLVED_PRESET_REQUIRED/);
  });

  it('supports flow-pass2 and flow-verify the same way', async () => {
    const engine = new InstalledOrcaEngine(fakeBridge());
    await engine.detect();
    for (const stepId of ['flow-pass2', 'flow-verify'] as const) {
      const step = getStepDefinition(stepId)!;
      const prepared = await engine.prepareProject(tempSession(), step, RESOLVED_FOR_FLOW);
      expect(prepared.stepId).toBe(stepId);
    }
  });
});

// --- InstalledOrcaEngine (web build, no bridge) -----------------------------

describe('InstalledOrcaEngine (web build)', () => {
  const webBridge = fakeBridge({ isDesktop: () => false });

  it('reports not-detected and refuses to slice off the desktop', async () => {
    const engine = new InstalledOrcaEngine(webBridge);
    const d = await engine.detect();
    expect(d.detected).toBe(false);
    expect(d.notes.join(' ') + (await engine.validate()).errors.join(' ')).toMatch(/desktop app/i);
    const caps = await engine.getCapabilities();
    expect(caps.slice).toBe(false);
    const job = await engine.slice(PREPARED, { outputDir: 'o', timeoutMs: 1000 });
    expect(job.succeeded).toBe(false);
  });
});

// --- ManagedOrcaEngine (Stage 9) --------------------------------------------

describe('ManagedOrcaEngine', () => {
  it('identifies as the managed engine and detects via the managed id', async () => {
    const calls: string[] = [];
    const engine = new ManagedOrcaEngine(
      fakeBridge({
        detectSlicingEngine: async (id: string) => {
          calls.push(id);
          return { ...VALID_ORCA, engine_id: id };
        }
      })
    );
    expect(engine.id).toBe('managed_orca');
    expect(engine.displayName).toBe('Managed OrcaSlicer');
    const status = await engine.status();
    expect(status.engineId).toBe('managed_orca'); // built from this.id, not the raw
    expect(calls).toContain('managed_orca');
    expect(calls).not.toContain('installed_orca');
  });

  it('shares the installed-Orca slicing path but tags jobs with its own id', async () => {
    const engine = new ManagedOrcaEngine(fakeBridge());
    const job = await engine.slice(PREPARED, { outputDir: 'o', timeoutMs: 1000 });
    expect(job.succeeded).toBe(true);
    expect(job.engineId).toBe('managed_orca');
  });

  it('reports not-detected off the desktop, same as the installed engine', async () => {
    const engine = new ManagedOrcaEngine(fakeBridge({ isDesktop: () => false }));
    const d = await engine.detect();
    expect(d.detected).toBe(false);
    expect((await engine.getCapabilities()).slice).toBe(false);
  });

  it('install() downloads-on-demand and returns the staged detection', async () => {
    let called = 0;
    const engine = new ManagedOrcaEngine(
      fakeBridge({
        downloadManagedOrca: async (token?: string) => {
          called++;
          expect(token).toBe('tok-1');
          return { ...VALID_ORCA, engine_id: 'managed_orca', display_name: 'Managed OrcaSlicer', source: 'managed' };
        }
      })
    );
    const d = await engine.install('tok-1');
    expect(called).toBe(1);
    expect(d.detected).toBe(true);
    expect(d.engineId).toBe('managed_orca');
    // The result is remembered, so a follow-up status needs no re-detect fallback.
    expect((await engine.getCapabilities()).slice).toBe(true);
  });

  it('install() is unavailable off the desktop', async () => {
    const engine = new ManagedOrcaEngine(fakeBridge({ isDesktop: () => false }));
    await expect(engine.install()).rejects.toThrow(/NOT_DESKTOP/);
  });
});

// --- engine diagnostics -----------------------------------------------------

describe('engine diagnostics', () => {
  it('recommends installed Orca when it is slice-capable', async () => {
    const diag = await discoverEngines(fakeBridge());
    expect(diag.desktop).toBe(true);
    expect(diag.recommendedEngineId).toBe('installed_orca');
    expect(diag.engines.map((e) => e.engineId)).toEqual(
      expect.arrayContaining(['installed_orca', 'managed_orca', 'manual_export'])
    );
    expect(diag.warnings).toHaveLength(0);
  });

  it('recommends the managed Orca when no installed Orca is usable but the managed one is', async () => {
    // The native side keys detection by engine id: installed is invalid here,
    // managed is valid — the managed engine should win over manual export.
    const diag = await discoverEngines(
      fakeBridge({
        detectSlicingEngine: async (id: string) =>
          id === 'managed_orca' ? { ...VALID_ORCA, engine_id: id } : { ...INVALID_ORCA, engine_id: id }
      })
    );
    expect(diag.recommendedEngineId).toBe('managed_orca');
    expect(diag.warnings).toHaveLength(0);
  });

  it('falls back to manual export when no slice-capable engine exists', async () => {
    const diag = await discoverEngines(fakeBridge({ detectSlicingEngine: async () => INVALID_ORCA }));
    expect(diag.recommendedEngineId).toBe('manual_export');
    expect(diag.warnings.join(' ')).toMatch(/no slice-capable engine/i);
  });

  it('recommends manual export and warns in a browser build', async () => {
    const diag = await discoverEngines(fakeBridge({ isDesktop: () => false }));
    expect(diag.desktop).toBe(false);
    expect(diag.recommendedEngineId).toBe('manual_export');
    expect(diag.warnings.join(' ')).toMatch(/browser build/i);
  });

  it('never throws — a probe failure surfaces as an engine error', async () => {
    const diag = await discoverEngines(
      fakeBridge({
        detectSlicingEngine: async () => {
          throw new Error('boom');
        }
      })
    );
    // manual export is still valid and recommended
    expect(diag.recommendedEngineId).toBe('manual_export');
    expect(diag.engines.some((e) => e.errors.some((m) => /probe failed/i.test(m)))).toBe(true);
  });
});
