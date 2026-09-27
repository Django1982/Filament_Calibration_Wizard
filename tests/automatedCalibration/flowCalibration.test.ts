import { describe, it, expect } from 'vitest';
import {
  parseObjectFlowModifier,
  computePrintFlowRatio,
  buildFlowObjectOverrides,
  buildFlowPlateOverrides,
  nozzleDependentObjectOverrides,
  bedExclusionIsEmpty,
  FLOW_FALLBACK_BED_EXCLUDE_AREA,
  FLOW_OBJECT_FIXED_OVERRIDES,
  FLOW_STEP_METHOD
} from '../../src/automatedCalibration/flowCalibration';

describe('parseObjectFlowModifier', () => {
  it('parses positive modifiers', () => {
    expect(parseObjectFlowModifier('flowrate_0')).toBe(0);
    expect(parseObjectFlowModifier('flowrate_5')).toBe(5);
    expect(parseObjectFlowModifier('flowrate_10')).toBe(10);
    expect(parseObjectFlowModifier('flowrate_20')).toBe(20);
  });

  it('remaps a leading "m" to a minus sign (Orca negative-name convention)', () => {
    expect(parseObjectFlowModifier('flowrate_m5')).toBe(-5);
    expect(parseObjectFlowModifier('flowrate_m10')).toBe(-10);
    expect(parseObjectFlowModifier('flowrate_m20')).toBe(-20);
  });

  it('parses the fine-grained linear/YOLO decimal names', () => {
    expect(parseObjectFlowModifier('flowrate_0.01')).toBeCloseTo(0.01);
    expect(parseObjectFlowModifier('flowrate_m0.05')).toBeCloseTo(-0.05);
  });

  it('falls back to Orca C++\'s own default (1.0) when the suffix does not parse', () => {
    expect(parseObjectFlowModifier('flowrate_bogus')).toBe(1.0);
  });
});

describe('computePrintFlowRatio', () => {
  it('percent formula: 1 + modifier/100 (Orca legacy pass1/pass2)', () => {
    expect(computePrintFlowRatio('percent', 0, 1)).toBe(1);
    expect(computePrintFlowRatio('percent', 10, 1)).toBeCloseTo(1.1);
    expect(computePrintFlowRatio('percent', -10, 1)).toBeCloseTo(0.9);
    // baseline is irrelevant to the percent formula
    expect(computePrintFlowRatio('percent', 10, 0.85)).toBeCloseTo(1.1);
  });

  it('linear/YOLO formula: (baseline + modifier) / baseline', () => {
    expect(computePrintFlowRatio('linear', 0, 0.98)).toBeCloseTo(1);
    expect(computePrintFlowRatio('linear', 0.02, 0.98)).toBeCloseTo(1.0204, 4);
    expect(computePrintFlowRatio('linear', -0.02, 0.98)).toBeCloseTo(0.9796, 4);
  });
});

describe('buildFlowObjectOverrides', () => {
  it('combines the fixed overrides, nozzle-dependent widths, and the computed ratio', () => {
    const overrides = buildFlowObjectOverrides(1.05, 0.4);
    expect(overrides.print_flow_ratio).toBe('1.05');
    expect(overrides.top_surface_line_width).toBe('0.48');
    expect(overrides.internal_solid_infill_line_width).toBe('0.48');
    // every fixed key is present, unmodified
    for (const [key, value] of Object.entries(FLOW_OBJECT_FIXED_OVERRIDES)) {
      expect(overrides[key]).toBe(value);
    }
  });

  it('scales the line width with nozzle diameter', () => {
    expect(buildFlowObjectOverrides(1, 0.6).top_surface_line_width).toBe('0.72');
  });
});

describe('FLOW_OBJECT_FIXED_OVERRIDES (pinned against Orca\'s adjust_settings_for_flowrate_calib)', () => {
  it('matches the real values verified against OrcaSlicer/OrcaSlicer source', () => {
    expect(FLOW_OBJECT_FIXED_OVERRIDES.wall_loops).toBe('1');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.only_one_wall_top).toBe('1');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.sparse_infill_density).toBe('35%');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.sparse_infill_pattern).toBe('rectilinear');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.top_surface_pattern).toBe('archimedeanchords');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.ironing_type).toBe('no ironing');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.center_of_surface_pattern).toBe('each_surface');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.gap_fill_target).toBe('nowhere');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.seam_slope_type).toBe('none');
    expect(FLOW_OBJECT_FIXED_OVERRIDES.top_surface_fill_order).toBe('default');
  });
});

describe('nozzleDependentObjectOverrides', () => {
  it('sets both line widths to nozzle * 1.2', () => {
    expect(nozzleDependentObjectOverrides(0.4)).toEqual({
      top_surface_line_width: '0.48',
      internal_solid_infill_line_width: '0.48'
    });
  });
});

describe('buildFlowPlateOverrides', () => {
  it('derives layer height from the nozzle and raises (never lowers) first-layer height', () => {
    const overrides = buildFlowPlateOverrides(0.4);
    expect(overrides.layer_height).toBe('0.2');
    expect(overrides.initial_layer_print_height).toBe('0.2');
    expect(overrides.alternate_extra_wall).toBe('0');
    expect(overrides.reduce_crossing_wall).toBe('1');
    expect(overrides.enable_wrapping_detection).toBe('0');
    expect(overrides.max_volumetric_extrusion_rate_slope).toBe('0');
  });

  it('never lowers an existing first-layer height below the derived layer height', () => {
    expect(buildFlowPlateOverrides(0.4, 0.28).initial_layer_print_height).toBe('0.28');
    expect(buildFlowPlateOverrides(0.4, 0.1).initial_layer_print_height).toBe('0.2');
  });

  it('scales with a larger nozzle', () => {
    expect(buildFlowPlateOverrides(0.6).layer_height).toBe('0.3');
  });
});

describe('FLOW_STEP_METHOD', () => {
  it('registers the percent formula for every currently-wired flow step', () => {
    expect(FLOW_STEP_METHOD['flow-pass1']).toBe('percent');
    expect(FLOW_STEP_METHOD['flow-pass2']).toBe('percent');
    expect(FLOW_STEP_METHOD['flow-verify']).toBe('percent');
  });
});

describe('bedExclusionIsEmpty (OrcaSlicer conflict-checker workaround)', () => {
  it('treats a missing or empty bed_exclude_area as empty', () => {
    expect(bedExclusionIsEmpty(undefined)).toBe(true);
    expect(bedExclusionIsEmpty(null)).toBe(true);
    expect(bedExclusionIsEmpty([])).toBe(true);
  });

  it('treats a defined exclusion polygon as non-empty', () => {
    expect(bedExclusionIsEmpty(['0x0', '18x0', '18x28', '0x28'])).toBe(false);
    expect(bedExclusionIsEmpty(FLOW_FALLBACK_BED_EXCLUDE_AREA)).toBe(false);
  });

  it('supplies a non-degenerate corner polygon as the fallback', () => {
    // Four points (a real quad) so Orca's conflict checker sees a valid
    // exclusion; a 1x1 mm corner clips nothing the centred objects use.
    expect(FLOW_FALLBACK_BED_EXCLUDE_AREA).toHaveLength(4);
    expect(FLOW_FALLBACK_BED_EXCLUDE_AREA[0]).toBe('0x0');
  });
});
