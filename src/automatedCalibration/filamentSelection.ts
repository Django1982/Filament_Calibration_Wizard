// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — material → Orca filament-preset selection
// (Stage 6). The last piece that makes arbitrary-printer resolution fully
// end-to-end: given the machine mapping (printerMapping.ts) plus the material
// being calibrated, pick a concrete Orca filament leaf name the resolver can
// walk into a flat project_settings.config.
//
// A PerfectFit `MaterialId` (PLA, PETG, …) maps to one or more Orca
// `filament_type` values; among the vendor's filament leaves compatible with the
// chosen machine, we rank a sensible generic default first (the user can always
// override with a specific brand in the Stage 7 UI). Filament is deliberately a
// separate choice from the printer — in a calibration the material IS what's
// being tuned — so nothing here is derived from the machine preset.
//
// Pure module (no fs, no native): callers pass the filament list obtained from
// the native `listVendorFilaments`.
// ---------------------------------------------------------------------------

import type { MaterialId } from '../types';
import type { RawFilamentPreset } from './engineBridge';

export interface OrcaFilamentPreset {
  vendor: string;
  /** Exact filament leaf name, e.g. "Bambu PLA Basic @BBL X1C". */
  name: string;
  filamentType: string | null;
  filamentVendor: string | null;
  compatiblePrinters: string[];
  universal: boolean;
}

/** Normalize the native snake_case payload into the module's shape. */
export function fromRawFilament(r: RawFilamentPreset): OrcaFilamentPreset {
  return {
    vendor: r.vendor,
    name: r.name,
    filamentType: r.filament_type,
    filamentVendor: r.filament_vendor,
    compatiblePrinters: r.compatible_printers,
    universal: r.universal
  };
}

/**
 * PerfectFit material → ordered Orca `filament_type` candidates (best first).
 * Fibre-filled and blended variants (PA-CF, PLA+, …) intentionally do NOT fall
 * back to a plain base type unless that base is a genuine substitute, so a
 * calibration never silently swaps in a materially different filament. `OTHER`
 * has no automatic mapping — the caller must let the user pick a leaf directly.
 */
export const MATERIAL_TO_ORCA_TYPES: Record<MaterialId, string[]> = {
  PLA: ['PLA'],
  // Orca has no distinct "PLA+" type; tough/PLA+ filaments are typed PLA.
  'PLA+': ['PLA'],
  PETG: ['PETG'],
  // PCTG has its own Orca type, but PETG is a close, widely-available substitute.
  PCTG: ['PCTG', 'PETG'],
  ABS: ['ABS'],
  ASA: ['ASA'],
  TPU: ['TPU'],
  PA: ['PA'],
  'PA-CF': ['PA-CF'],
  // No plain "PA-GF" type is common; PA-CF is the nearest filled-nylon profile.
  'PA-GF': ['PA-GF', 'PA-CF'],
  PC: ['PC'],
  // PPA usually ships only as filled variants in Orca's library.
  PPA: ['PPA', 'PPA-CF', 'PPA-GF'],
  PPS: ['PPS', 'PPS-CF'],
  OTHER: []
};

/** Orca filament_type candidates for a material, or [] when unmapped. */
export function orcaTypesForMaterial(material: MaterialId): string[] {
  return MATERIAL_TO_ORCA_TYPES[material] ?? [];
}

/** Filaments compatible with a machine leaf: those that list it, plus universal
 *  ones (empty compatible_printers). Order is preserved. */
export function filamentsForMachine(
  filaments: OrcaFilamentPreset[],
  machineName: string
): OrcaFilamentPreset[] {
  return filaments.filter((f) => f.universal || f.compatiblePrinters.includes(machineName));
}

export interface FilamentSelectionOptions {
  /** Restrict to filaments compatible with this machine leaf, when given. */
  machineName?: string;
  /** Prefer this filament brand (matched case-insensitively against
   *  filamentVendor, else the leaf name), e.g. "Bambu", "Generic". */
  preferBrand?: string;
}

/** Words that mark a specialty/variant filament we avoid as an auto-default —
 *  a calibration wants a representative generic, not a silk/matte/glow blend. */
const SPECIALTY = /\b(silk|matte|metal|marble|glow|sparkle|wood|dual|gradient|rainbow|luminous|galaxy|sparkl)/i;
const GENERIC = /\b(basic|generic)\b/i;

/**
 * Rank the candidate filaments for a material, best first. Only leaves whose
 * `filamentType` matches one of the material's Orca types survive; ties break by
 * (1) earlier type candidate, (2) preferred brand, (3) a generic/"Basic" name,
 * (4) not a specialty blend, then (5) name, so the result is deterministic.
 */
export function filamentsForMaterial(
  filaments: OrcaFilamentPreset[],
  material: MaterialId,
  opts: FilamentSelectionOptions = {}
): OrcaFilamentPreset[] {
  const types = orcaTypesForMaterial(material);
  if (types.length === 0) return [];
  const typeRank = new Map(types.map((t, i) => [t, i]));

  let pool = filaments;
  if (opts.machineName) pool = filamentsForMachine(pool, opts.machineName);

  const brand = opts.preferBrand?.toLowerCase();
  const scored = pool
    .filter((f) => f.filamentType !== null && typeRank.has(f.filamentType))
    .map((f) => {
      const brandHit =
        !!brand &&
        ((f.filamentVendor?.toLowerCase().includes(brand) ?? false) ||
          f.name.toLowerCase().includes(brand));
      return {
        f,
        typeIdx: typeRank.get(f.filamentType as string) ?? Number.MAX_SAFE_INTEGER,
        brandRank: brandHit ? 0 : 1,
        genericRank: GENERIC.test(f.name) ? 0 : 1,
        specialtyRank: SPECIALTY.test(f.name) ? 1 : 0
      };
    });

  scored.sort(
    (a, b) =>
      a.typeIdx - b.typeIdx ||
      a.brandRank - b.brandRank ||
      a.genericRank - b.genericRank ||
      a.specialtyRank - b.specialtyRank ||
      a.f.name.localeCompare(b.f.name)
  );
  return scored.map((s) => s.f);
}

/** The single best filament preset for a material, or null when none match. */
export function selectFilamentForMaterial(
  filaments: OrcaFilamentPreset[],
  material: MaterialId,
  opts: FilamentSelectionOptions = {}
): OrcaFilamentPreset | null {
  return filamentsForMaterial(filaments, material, opts)[0] ?? null;
}
