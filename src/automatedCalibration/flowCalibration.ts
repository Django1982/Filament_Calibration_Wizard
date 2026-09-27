// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — flow-rate calibration parameterization
// (Stage 6, finishing increment).
//
// Orca's shipped `resources/calib/filament_flow/flowrate-test-pass{1,2}.3mf` are
// bare multi-object plates (9 or 10 objects named e.g. `flowrate_0`,
// `flowrate_m10`) with NO embedded config at all — confirmed by inspecting the
// real files. Orca's own GUI wizard (`Plater::calib_flowrate` /
// `adjust_settings_for_flowrate_calib` in `src/slic3r/GUI/Plater.cpp`, public
// AGPL source) turns each object's name into a PER-OBJECT `print_flow_ratio`
// process override — not a filament-level setting — by stripping the
// `"flowrate_"` prefix (9 chars), remapping a leading `m` to a minus sign, and
// combining the parsed number with the filament's current flow ratio:
//
//   - percent (legacy pass1/pass2): print_flow_ratio = 1 + modifier/100
//   - linear (YOLO):                print_flow_ratio = (baseline + modifier) / baseline
//
// Orca also applies a fixed set of print-quality overrides on every calibration
// object (single wall, 35% rectilinear infill, the test's top-surface pattern,
// etc.) plus a few plate-level settings (layer height tied to the nozzle, wall
// crossing avoidance, …). This module reproduces exactly those values — pure,
// no fs — so the engine layer only has to hand the computed overrides to the
// native assembler (`assemble_flow_test`), which formats them into
// `model_settings.config` without knowing the calibration math itself.
//
// Deliberately NOT reproduced (see HQ STATUS.md): Orca's GUI also rescales the
// build item in Z for non-0.2mm layer heights and computes dynamic
// max-volumetric-speed clamp arrays per pass. For the common 0.4mm-nozzle /
// 0.2mm-layer profile family (this module's `nozzleDependentObjectOverrides`
// input), Orca's own scale formula already resolves to identity, so this is a
// deliberate, documented narrowing — not an oversight.
// ---------------------------------------------------------------------------

export type FlowTestMethod = 'percent' | 'linear';

/** Strip Orca's `"flowrate_"` prefix (9 characters) from an object name and
 *  parse the signed modifier, mirroring `adjust_settings_for_flowrate_calib`'s
 *  `obj_name.substr(9)` + leading-`'m'`-to-`'-'` remap exactly. Falls back to
 *  Orca's own default (`1.0`) when the suffix doesn't parse — the C++ leaves
 *  its `modifier` variable at its prior value (1.0f) on a `stof` exception. */
export function parseObjectFlowModifier(objectName: string): number {
  const suffix = objectName.slice(9);
  const signed = suffix.startsWith('m') ? `-${suffix.slice(1)}` : suffix;
  const n = Number.parseFloat(signed);
  return Number.isFinite(n) ? n : 1.0;
}

/** Compute an object's `print_flow_ratio` override from its modifier, mirroring
 *  Orca's two formulas exactly (`Plater::calib_flowrate`'s `linear` branch). */
export function computePrintFlowRatio(
  method: FlowTestMethod,
  modifier: number,
  baselineFlowRatio: number
): number {
  if (method === 'linear') return (baselineFlowRatio + modifier) / baselineFlowRatio;
  return 1.0 + modifier / 100;
}

/** Compact numeric formatting consistent with how Orca serializes plain
 *  (non-percent) config numbers — no unnecessary trailing zeros. */
function formatNum(n: number): string {
  return Number(n.toFixed(5)).toString();
}

/** The fixed per-object print-quality overrides Orca applies to EVERY
 *  calibration object, independent of nozzle size or the object's own flow
 *  modifier (`adjust_settings_for_flowrate_calib`'s per-object loop, minus the
 *  nozzle-dependent line widths and the per-object `print_flow_ratio` itself —
 *  see `nozzleDependentObjectOverrides` and `computePrintFlowRatio`). Values are
 *  pre-formatted the way `ConfigBase::serialize()` writes them (percent keys
 *  keep a trailing `%`, booleans are `"0"`/`"1"`, enums are Orca's lowercase
 *  string keys — verified against real shipped process-preset JSON). */
export const FLOW_OBJECT_FIXED_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  wall_loops: '1',
  only_one_wall_top: '1',
  thick_internal_bridges: '0',
  enable_extra_bridge_layer: 'disabled',
  internal_bridge_density: '100%',
  sparse_infill_density: '35%',
  min_width_top_surface: '100%',
  bottom_shell_layers: '2',
  top_shell_layers: '5',
  top_shell_thickness: '0',
  bottom_shell_thickness: '0',
  detect_thin_wall: '1',
  filter_out_gap_fill: '0',
  sparse_infill_pattern: 'rectilinear',
  top_surface_pattern: 'archimedeanchords',
  top_solid_infill_flow_ratio: '1',
  infill_direction: '45',
  solid_infill_direction: '135',
  center_of_surface_pattern: 'each_surface',
  separated_infills: '0',
  align_infill_direction_to_model: '1',
  ironing_type: 'no ironing',
  calib_flowrate_topinfill_special_order: '1',
  top_surface_fill_order: 'default',
  seam_slope_type: 'none',
  gap_fill_target: 'nowhere'
});

/** The nozzle-dependent per-object line widths (`nozzle_diameter * 1.2`, no
 *  percent suffix — a plain `FloatOrPercent` in absolute-mm mode). */
export function nozzleDependentObjectOverrides(nozzleDiameterMm: number): Record<string, string> {
  const width = formatNum(nozzleDiameterMm * 1.2);
  return {
    top_surface_line_width: width,
    internal_solid_infill_line_width: width
  };
}

/** The complete per-object override set for one flow-test plate object: the
 *  fixed print-quality settings, the nozzle-dependent line widths, and this
 *  object's own computed `print_flow_ratio`. */
export function buildFlowObjectOverrides(
  printFlowRatio: number,
  nozzleDiameterMm: number
): Record<string, string> {
  return {
    ...FLOW_OBJECT_FIXED_OVERRIDES,
    ...nozzleDependentObjectOverrides(nozzleDiameterMm),
    print_flow_ratio: formatNum(printFlowRatio)
  };
}

/** The plate-level (project_settings.config) overrides Orca's flow-calibration
 *  wizard applies: a layer height tied to the nozzle (0.2mm for a 0.4mm nozzle)
 *  and a handful of print-quality settings tuned for a clean plate of small
 *  objects. `existingInitialLayerHeightMm` is the resolved process's own value —
 *  Orca only raises it, never lowers it below the derived layer height. */
export function buildFlowPlateOverrides(
  nozzleDiameterMm: number,
  existingInitialLayerHeightMm?: number
): Record<string, string> {
  const layerHeight = nozzleDiameterMm / 2;
  const firstLayerHeight = Math.max(existingInitialLayerHeightMm ?? layerHeight, layerHeight);
  return {
    layer_height: formatNum(layerHeight),
    initial_layer_print_height: formatNum(firstLayerHeight),
    alternate_extra_wall: '0',
    reduce_crossing_wall: '1',
    enable_wrapping_detection: '0',
    max_volumetric_extrusion_rate_slope: '0'
  };
}

/**
 * A minimal bed exclusion applied to the flow-test plate when the resolved
 * printer preset declares NONE.
 *
 * OrcaSlicer's g-code path-conflict checker (CLI exit -101 =
 * `CLI_GCODE_PATH_CONFLICTS`) spuriously rejects the flow test's tightly-packed
 * multi-object plate (nine 40×30 mm objects with ~2 mm gaps) when the machine
 * preset's `bed_exclude_area` is empty. Verified against real OrcaSlicer 2.4.2:
 * stripping the Bambu X1 Carbon's own exclude area reproduces the -101, and any
 * non-empty polygon — even a 1×1 mm square in the (0,0) corner — suppresses it.
 * Presets that already define an exclusion (e.g. Bambu X1C) are untouched; ones
 * whose exclusion is legitimately empty (e.g. Bambu H2S) need this. The
 * calibration objects are centred on the plate and never reach the corner, so
 * the exclusion clips nothing — and it lives only in the throwaway calibration
 * project, never in any of the user's saved presets.
 */
export const FLOW_FALLBACK_BED_EXCLUDE_AREA: readonly string[] = Object.freeze([
  '0x0',
  '1x0',
  '1x1',
  '0x1'
]);

/** True when a config's `bed_exclude_area` is missing or an empty array — the
 *  state that trips OrcaSlicer's conflict checker on the flow plate (see
 *  `FLOW_FALLBACK_BED_EXCLUDE_AREA`). */
export function bedExclusionIsEmpty(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

/** Which formula a registered flow-calibration step uses. All three steps
 *  currently wired to an asset (`flow-pass1`, `flow-pass2`, `flow-verify`) are
 *  Orca's legacy percent-modifier tests; the linear/YOLO test isn't registered
 *  as a calibration asset yet (see assets.ts), so this is exhaustive today but
 *  intentionally keyed generically for when YOLO is added. */
export const FLOW_STEP_METHOD: Readonly<Record<string, FlowTestMethod>> = Object.freeze({
  'flow-pass1': 'percent',
  'flow-pass2': 'percent',
  'flow-verify': 'percent'
});
