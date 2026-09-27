// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — Orca project_settings.config merge (Stage 6).
//
// A complete Orca project 3mf embeds `Metadata/project_settings.config`: a
// FLAT, fully-resolved settings object (no `inherits`) whose filament values are
// arrays of strings (one entry per extruder slot). To turn a shipped calibration
// project into one carrying the session's calibrated values, PerfectFit parses
// that config, overwrites only the calibrated filament keys, and serializes it
// back — leaving every other setting (printer geometry, start/stop g-code,
// process settings) byte-for-byte untouched.
//
// The calibration-result → Orca-key mapping is NOT reinvented here: it reuses
// `buildPatchesFromProject` from the profile installer (the same mapping the
// verified direct-install path uses), and applies each patch with the same
// array-of-strings / NO_NIL semantics as `cloneAndPatch`. Pure module (no fs):
// physical staging and re-zipping happen on the Rust side.
// ---------------------------------------------------------------------------

import type { CalibrationProject } from '../types';
import type { CalibratedFieldPatch } from '../slicerIntegration/types';
import { buildPatchesFromProject } from '../slicerIntegration/generator';
import { formatPresetNumber } from '../slicerIntegration/orcaFamily';

/** Filament keys that must never hold "nil" — the slicer requires a concrete
 *  value. Mirrors the profile installer's NO_NIL set. */
const NO_NIL = new Set([
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
  'filament_flow_ratio',
  'filament_max_volumetric_speed',
  'pressure_advance',
  'filament_shrink'
]);

export interface ConfigMergeResult {
  /** The merged config object (a new object; the input is not mutated). */
  config: Record<string, unknown>;
  /** Orca keys whose value changed, in application order. */
  appliedKeys: string[];
  /** Human-readable notes (e.g. a key created because the template lacked it). */
  notes: string[];
}

/** Parse a `project_settings.config` (plain JSON) into a settings object. */
export function parseProjectConfig(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`INVALID_PROJECT_CONFIG: not valid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('INVALID_PROJECT_CONFIG: expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Apply calibration patches to a config's filament arrays. A calibration
 * project is single-filament, so a patched value is written to EVERY slot the
 * template declares (or a fresh single-slot array when the key is absent).
 * Returns a new object; the input is left untouched. Key insertion order is
 * preserved so the serialized config diffs minimally against the template.
 */
export function applyPatchesToConfig(
  config: Record<string, unknown>,
  patches: CalibratedFieldPatch[]
): ConfigMergeResult {
  const out: Record<string, unknown> = { ...config };
  const appliedKeys: string[] = [];
  const notes: string[] = [];

  const setArray = (key: string, value: string): boolean => {
    const existing = out[key];
    let arr: string[];
    if (Array.isArray(existing) && existing.length > 0 && existing.every((x) => typeof x === 'string')) {
      arr = (existing as string[]).map(() => value);
    } else {
      if (!(key in out)) notes.push(`Key '${key}' was not in the template; added it.`);
      arr = [value];
    }
    const changed = !Array.isArray(existing) || (existing as unknown[]).some((x) => x !== value);
    out[key] = arr;
    return changed;
  };

  for (const patch of patches) {
    const after = formatPresetNumber(patch.value) + (patch.valueSuffix ?? '');
    if (!NO_NIL.has(patch.presetKey) && after === 'nil') {
      // Defensive: a calibrated value should never format to nil.
      notes.push(`Skipped '${patch.presetKey}' — no concrete value.`);
      continue;
    }
    if (setArray(patch.presetKey, after)) appliedKeys.push(patch.presetKey);
    for (const comp of patch.companions ?? []) {
      if (setArray(comp.presetKey, comp.value)) appliedKeys.push(comp.presetKey);
    }
  }

  return { config: out, appliedKeys, notes };
}

/**
 * Serialize a project config the way Orca writes it: 4-space indent, a trailing
 * newline, and — crucially — the template's own key order preserved (we never
 * re-sort, so the huge start/stop g-code blocks and every untouched setting stay
 * put). Orca reads this back without complaint (verified format, Orca 2.4.2).
 */
export function serializeProjectConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 4) + '\n';
}

export interface MergedProjectConfig {
  /** The merged config serialized ready for a project 3mf's config entry. */
  text: string;
  /** Orca keys whose value changed, in application order. */
  appliedKeys: string[];
  notes: string[];
  /** The printer the base config targets (so a caller can warn on a mismatch). */
  printerSettingsId: string | null;
}

/**
 * Merge a session's calibrated values into a config OBJECT and serialize it. The
 * base config may be a template's own `project_settings.config` (carrying the
 * template's printer) or a resolved arbitrary-printer config from
 * `resolvePrinterPreset` — either way only the calibrated filament keys change.
 * `printerSettingsId` reports the printer the base config targets.
 */
export function mergeCalibrationIntoConfig(
  baseConfig: Record<string, unknown>,
  project: CalibrationProject
): MergedProjectConfig {
  const patches = buildPatchesFromProject(project);
  const merged = applyPatchesToConfig(baseConfig, patches);
  const printerSettingsId =
    typeof merged.config.printer_settings_id === 'string'
      ? (merged.config.printer_settings_id as string)
      : null;
  return {
    text: serializeProjectConfig(merged.config),
    appliedKeys: merged.appliedKeys,
    notes: merged.notes,
    printerSettingsId
  };
}

/**
 * End-to-end: parse a template `project_settings.config` text, merge in a
 * session's calibrated values, and serialize the result. Thin wrapper over
 * `mergeCalibrationIntoConfig` for the common case where the base config comes
 * from a template 3mf as text.
 */
export function mergeCalibrationIntoProjectConfig(
  templateConfigText: string,
  project: CalibrationProject
): MergedProjectConfig {
  return mergeCalibrationIntoConfig(parseProjectConfig(templateConfigText), project);
}
