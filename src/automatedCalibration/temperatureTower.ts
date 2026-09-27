// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — temperature-tower parameterization (Stage 6).
//
// A temperature tower is a bare model (Orca ships `temperature_tower.stl`): the
// geometry alone is inert. The test is created by changing the hotend
// temperature at each height band, which Orca encodes in a project 3mf as
// `Metadata/custom_gcode_per_layer.xml` — a list of per-layer custom g-code
// entries. This module produces that XML for a tower: given the band geometry
// and the start/end/step temperatures, it computes the Z height of each band top
// and the temperature to set there, then serializes the exact XML shape Orca
// writes (verified against a shipped Orca project: `type="4"` = a Custom g-code
// entry, an `M104 S<temp>` no-wait set in `extra`).
//
// Pure module (no fs, no native): the caller supplies the model's band geometry
// and the material's temperature range; native assembly (wrapping the STL into a
// project 3mf that embeds this XML plus the resolved config) is the next step.
//
// CONFIRMED from a real Orca temp-tower slice (Bambu H2S, PLA, OrcaSlicer 2.4.2,
// 2026-07-26): a tower has one 10 mm band per temperature, stepping DOWN by 5 °C
// from the filament's `nozzle_temperature` (e.g. 230→190 = 9 bands = 90 mm). Orca
// itself emits `M104 S<temp> ; set nozzle temperature` on EVERY layer and cuts
// its 370 mm master STL down to band-count × 10 mm. It does NOT store a
// `custom_gcode_per_layer.xml`. PerfectFit reproduces the same temperatures the
// robust way — one Custom (type=4) `M104` change at each band boundary in a
// custom_gcode_per_layer.xml (the pa_pattern-proven injection path) — so a
// normally-sliced project reaches the identical per-band temperatures without
// depending on Orca's internal temp-tower recognition. `ORCA_BAND_HEIGHT_MM` /
// `ORCA_TEMP_STEP_C` capture those measured constants; `defaultTowerGeometry`
// and `towerHeightMm` feed both the generator and the (native) model cut.
// ---------------------------------------------------------------------------

/**
 * Orca's sentinel `extruder` value for a per-layer entry that isn't tied to a
 * specific extruder (0xCCCCCCCC read as a signed i32) — copied verbatim from a
 * shipped Orca project so the entry round-trips identically.
 */
export const UNSET_EXTRUDER = -858993460;

/** A Custom g-code per-layer entry (Orca `type="4"`). */
export const CUSTOM_GCODE_TYPE = 4;

/** Printed height of one temperature band, mm (measured: 50 layers × 0.2 mm). */
export const ORCA_BAND_HEIGHT_MM = 10;

/** Temperature decrement between adjacent bands, °C (measured: 5 °C). */
export const ORCA_TEMP_STEP_C = 5;

export interface TemperatureTowerGeometry {
  /** Printed height of each temperature band (mm). */
  bandHeightMm: number;
  /**
   * Height (mm) printed before the first temperature CHANGE takes effect — the
   * base plus the first band, which print at `startTemp`. The first change is
   * emitted at `baseHeightMm`.
   */
  baseHeightMm: number;
  /** Layer height (mm), used to snap band boundaries to actual layer tops. */
  layerHeightMm: number;
}

export interface TemperatureRange {
  /** Temperature of the first (bottom) band, °C — the hottest. */
  startTemp: number;
  /** Temperature of the last (top) band, °C — the coolest. */
  endTemp: number;
  /** Positive °C decrement between adjacent bands. */
  step: number;
}

export interface TemperatureBand {
  /** Z height (mm) at which this band's temperature is set. */
  topZ: number;
  /** Hotend temperature to set at `topZ` (°C). */
  temperature: number;
}

/** Snap a raw Z to the nearest layer top at the given layer height. Rounded to
 *  µm to shed floating-point noise (e.g. 51 * 0.2 = 10.200000000000001). */
function snapToLayer(z: number, layerHeightMm: number): number {
  if (layerHeightMm <= 0) return z;
  return Number((Math.round(z / layerHeightMm) * layerHeightMm).toFixed(4));
}

/** Format a number the compact way Orca writes Z values (no trailing zeros). */
function formatZ(n: number): string {
  // Round to 3 decimals (µm precision) then strip trailing zeros.
  return String(Number(n.toFixed(3)));
}

/**
 * Compute the temperature-change bands for a tower. The first band prints at
 * `startTemp` (set in the project/filament config, not here); each subsequent
 * band gets a change entry at its base Z. Descends by `step` from `startTemp`
 * toward `endTemp` (inclusive when the range divides evenly). Returns the
 * changes only — the count is `ceil((startTemp-endTemp)/step)` entries.
 */
export function buildTemperatureBands(
  range: TemperatureRange,
  geometry: TemperatureTowerGeometry
): TemperatureBand[] {
  const { startTemp, endTemp, step } = range;
  if (step <= 0) throw new Error('TEMP_TOWER: step must be positive');
  if (startTemp < endTemp) throw new Error('TEMP_TOWER: startTemp must be >= endTemp');
  const { bandHeightMm, baseHeightMm, layerHeightMm } = geometry;
  if (bandHeightMm <= 0) throw new Error('TEMP_TOWER: bandHeightMm must be positive');

  const bands: TemperatureBand[] = [];
  let temperature = startTemp - step;
  let index = 0;
  // Emit one change per subsequent band while still above endTemp.
  while (temperature >= endTemp - 1e-9) {
    const rawZ = baseHeightMm + index * bandHeightMm;
    bands.push({ topZ: snapToLayer(rawZ, layerHeightMm), temperature });
    temperature -= step;
    index += 1;
  }
  return bands;
}

/** Escape the five XML entities for text placed in an attribute value. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Serialize temperature bands into Orca's `custom_gcode_per_layer.xml`. Each
 * band becomes a Custom (`type="4"`) entry that sets the hotend temperature with
 * a no-wait `M104 S<temp>` at the band's top_z, matching the shape Orca writes.
 */
export function serializeCustomGcodePerLayer(bands: TemperatureBand[], plateId = 1): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<custom_gcodes_per_layer>',
    '<plate>',
    `<plate_info id="${plateId}"/>`
  ];
  for (const band of bands) {
    const extra = escapeXmlAttr(`M104 S${band.temperature}`);
    lines.push(
      `<layer top_z="${formatZ(band.topZ)}" type="${CUSTOM_GCODE_TYPE}" ` +
        `extruder="${UNSET_EXTRUDER}" color="" extra="${extra}"/>`
    );
  }
  lines.push('</plate>', '</custom_gcodes_per_layer>', '');
  return lines.join('\n');
}

/** Convenience: bands + XML in one call. */
export function generateTemperatureTowerGcode(
  range: TemperatureRange,
  geometry: TemperatureTowerGeometry
): { bands: TemperatureBand[]; xml: string } {
  const bands = buildTemperatureBands(range, geometry);
  return { bands, xml: serializeCustomGcodePerLayer(bands) };
}

/**
 * The tower geometry Orca uses (band + base = one 10 mm band at the start temp),
 * for the given layer height. This is the geometry to pass to the generator and
 * to size the model cut so the printed bands line up with the temperature
 * changes.
 */
export function defaultTowerGeometry(layerHeightMm = 0.2): TemperatureTowerGeometry {
  return {
    bandHeightMm: ORCA_BAND_HEIGHT_MM,
    baseHeightMm: ORCA_BAND_HEIGHT_MM,
    layerHeightMm
  };
}

/** Number of temperature bands for a range (inclusive of start and end). */
export function bandCount(range: TemperatureRange): number {
  if (range.step <= 0) throw new Error('TEMP_TOWER: step must be positive');
  if (range.startTemp < range.endTemp) throw new Error('TEMP_TOWER: startTemp must be >= endTemp');
  return Math.floor((range.startTemp - range.endTemp) / range.step) + 1;
}

/**
 * Printed height (mm) the tower model must have for a range — `bandCount` bands
 * of `bandHeightMm`. Orca cuts its 370 mm master STL to exactly this; the native
 * assembler must cut to the same height so bands align with the temperatures.
 */
export function towerHeightMm(
  range: TemperatureRange,
  geometry: TemperatureTowerGeometry = defaultTowerGeometry()
): number {
  return bandCount(range) * geometry.bandHeightMm;
}
