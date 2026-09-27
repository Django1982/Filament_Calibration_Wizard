import { describe, it, expect } from 'vitest';
import {
  parseProjectConfig,
  applyPatchesToConfig,
  serializeProjectConfig,
  mergeCalibrationIntoProjectConfig
} from '../../src/automatedCalibration/orcaProjectConfig';
import type { CalibrationProject } from '../../src/types';
import type { CalibratedFieldPatch } from '../../src/slicerIntegration/types';

// A minimal but realistically-shaped project_settings.config: filament values
// are arrays of strings, and there is a big untouched g-code block plus the
// printer id, exactly like a real Orca calibration project.
const TEMPLATE = JSON.stringify(
  {
    accel_to_decel_enable: '0',
    filament_flow_ratio: ['1'],
    nozzle_temperature: ['220'],
    nozzle_temperature_initial_layer: ['220'],
    pressure_advance: ['0.02'],
    enable_pressure_advance: ['0'],
    machine_start_gcode: 'G28\nG1 Z5\n; big block stays put',
    printer_settings_id: 'Bambu Lab N1 0.4 nozzle',
    print_settings_id: '0.20mm Standard @BBL N1'
  },
  null,
  4
);

function completedProject(): CalibrationProject {
  return {
    steps: {
      temperature: { status: 'completed' },
      'pressure-advance': { status: 'completed' },
      'flow-pass1': { status: 'completed' }
    },
    finals: {
      nozzleTemp: 210,
      firstLayerTemp: 215,
      pressureAdvance: 0.018,
      flowRatio: 0.97
    }
  } as unknown as CalibrationProject;
}

describe('parseProjectConfig', () => {
  it('rejects non-JSON and non-objects with a clear code', () => {
    expect(() => parseProjectConfig('not json')).toThrow(/INVALID_PROJECT_CONFIG/);
    expect(() => parseProjectConfig('[1,2,3]')).toThrow(/INVALID_PROJECT_CONFIG/);
    expect(parseProjectConfig('{"a":"b"}')).toEqual({ a: 'b' });
  });
});

describe('applyPatchesToConfig', () => {
  it('overwrites every filament slot and does not mutate the input', () => {
    const config = { filament_flow_ratio: ['1', '1'], other: 'keep' };
    const patches: CalibratedFieldPatch[] = [
      { sourceKey: 'flowRatio', presetKey: 'filament_flow_ratio', label: 'Flow', value: 0.95, unit: '' }
    ];
    const result = applyPatchesToConfig(config, patches);
    expect(result.config.filament_flow_ratio).toEqual(['0.95', '0.95']);
    expect(result.appliedKeys).toContain('filament_flow_ratio');
    // input untouched
    expect(config.filament_flow_ratio).toEqual(['1', '1']);
    expect(result.config.other).toBe('keep');
  });

  it('adds an absent key as a single-slot array and notes it', () => {
    const result = applyPatchesToConfig(
      {},
      [{ sourceKey: 'pressureAdvance', presetKey: 'pressure_advance', label: 'PA', value: 0.02, unit: '' }]
    );
    expect(result.config.pressure_advance).toEqual(['0.02']);
    expect(result.notes.join(' ')).toMatch(/pressure_advance/);
  });

  it('applies companion keys (enable_pressure_advance) alongside', () => {
    const result = applyPatchesToConfig({ pressure_advance: ['0'], enable_pressure_advance: ['0'] }, [
      {
        sourceKey: 'pressureAdvance',
        presetKey: 'pressure_advance',
        label: 'PA',
        value: 0.03,
        unit: '',
        companions: [{ presetKey: 'enable_pressure_advance', value: '1' }]
      }
    ]);
    expect(result.config.pressure_advance).toEqual(['0.03']);
    expect(result.config.enable_pressure_advance).toEqual(['1']);
  });
});

describe('serializeProjectConfig', () => {
  it('preserves template key order (never re-sorts) and ends with a newline', () => {
    const config = parseProjectConfig(TEMPLATE);
    const text = serializeProjectConfig(config);
    expect(text.endsWith('\n')).toBe(true);
    // key order preserved: accel_... before filament_... before printer_settings_id
    expect(text.indexOf('accel_to_decel_enable')).toBeLessThan(text.indexOf('filament_flow_ratio'));
    expect(text.indexOf('machine_start_gcode')).toBeLessThan(text.indexOf('printer_settings_id'));
  });
});

describe('mergeCalibrationIntoProjectConfig', () => {
  it('carries calibrated filament values into the config, untouched elsewhere', () => {
    const { text, appliedKeys, printerSettingsId } = mergeCalibrationIntoProjectConfig(TEMPLATE, completedProject());
    const merged = parseProjectConfig(text);

    expect(merged.nozzle_temperature).toEqual(['210']);
    expect(merged.nozzle_temperature_initial_layer).toEqual(['215']);
    expect(merged.pressure_advance).toEqual(['0.018']);
    expect(merged.enable_pressure_advance).toEqual(['1']); // companion turned on
    expect(merged.filament_flow_ratio).toEqual(['0.97']);

    // untouched settings survive verbatim
    expect(merged.machine_start_gcode).toBe('G28\nG1 Z5\n; big block stays put');
    expect(merged.print_settings_id).toBe('0.20mm Standard @BBL N1');

    expect(appliedKeys).toEqual(expect.arrayContaining(['nozzle_temperature', 'pressure_advance', 'filament_flow_ratio']));
    expect(printerSettingsId).toBe('Bambu Lab N1 0.4 nozzle');
  });

  it('applies nothing when no calibration step is completed', () => {
    const empty = { steps: {}, finals: {} } as unknown as CalibrationProject;
    const { appliedKeys } = mergeCalibrationIntoProjectConfig(TEMPLATE, empty);
    expect(appliedKeys).toHaveLength(0);
  });
});
