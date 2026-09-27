import { describe, it, expect } from 'vitest';
import {
  fromRawFilament,
  orcaTypesForMaterial,
  filamentsForMachine,
  filamentsForMaterial,
  selectFilamentForMaterial,
  MATERIAL_TO_ORCA_TYPES
} from '../../src/automatedCalibration';
import type { OrcaFilamentPreset } from '../../src/automatedCalibration';
import type { RawFilamentPreset } from '../../src/automatedCalibration';

const raw = (over: Partial<RawFilamentPreset>): RawFilamentPreset => ({
  vendor: 'BBL',
  name: 'X',
  filament_type: 'PLA',
  filament_vendor: 'Bambu',
  compatible_printers: ['M 0.4 nozzle'],
  universal: false,
  ...over
});

const preset = (over: Partial<OrcaFilamentPreset>): OrcaFilamentPreset => ({
  vendor: 'BBL',
  name: 'X',
  filamentType: 'PLA',
  filamentVendor: 'Bambu',
  compatiblePrinters: ['M 0.4 nozzle'],
  universal: false,
  ...over
});

describe('material → Orca type mapping', () => {
  it('maps every PerfectFit material (OTHER is intentionally unmapped)', () => {
    for (const [material, types] of Object.entries(MATERIAL_TO_ORCA_TYPES)) {
      if (material === 'OTHER') expect(types).toEqual([]);
      else expect(types.length).toBeGreaterThan(0);
    }
    expect(orcaTypesForMaterial('PLA')).toEqual(['PLA']);
    expect(orcaTypesForMaterial('PLA+')).toEqual(['PLA']); // PLA+ is typed PLA in Orca
    expect(orcaTypesForMaterial('PCTG')[0]).toBe('PCTG');
  });
});

describe('fromRawFilament', () => {
  it('normalizes snake_case to camelCase', () => {
    const p = fromRawFilament(raw({ name: 'Y', filament_type: 'PETG', universal: true }));
    expect(p).toEqual({
      vendor: 'BBL',
      name: 'Y',
      filamentType: 'PETG',
      filamentVendor: 'Bambu',
      compatiblePrinters: ['M 0.4 nozzle'],
      universal: true
    });
  });
});

describe('filamentsForMachine', () => {
  it('keeps universal filaments and those listing the machine', () => {
    const list = [
      preset({ name: 'listed', compatiblePrinters: ['M 0.4 nozzle'] }),
      preset({ name: 'other', compatiblePrinters: ['Z 0.4 nozzle'] }),
      preset({ name: 'universal', compatiblePrinters: [], universal: true })
    ];
    expect(filamentsForMachine(list, 'M 0.4 nozzle').map((f) => f.name)).toEqual(['listed', 'universal']);
  });
});

describe('filamentsForMaterial ranking', () => {
  const list = [
    preset({ name: 'Bambu PLA Silk @M', filamentType: 'PLA', filamentVendor: 'Bambu' }),
    preset({ name: 'Bambu PLA Basic @M', filamentType: 'PLA', filamentVendor: 'Bambu' }),
    preset({ name: 'Generic PLA @M', filamentType: 'PLA', filamentVendor: 'Generic' }),
    preset({ name: 'Bambu PETG @M', filamentType: 'PETG', filamentVendor: 'Bambu' })
  ];

  it('filters to the material type and prefers a generic "Basic" over a specialty', () => {
    const ranked = filamentsForMaterial(list, 'PLA');
    expect(ranked.every((f) => f.filamentType === 'PLA')).toBe(true);
    // "Basic" and "Generic" (generic markers) rank above "Silk" (specialty)
    expect(ranked[ranked.length - 1].name).toBe('Bambu PLA Silk @M');
    expect(ranked[0].name).toMatch(/Basic|Generic/);
  });

  it('honors a brand preference', () => {
    const best = selectFilamentForMaterial(list, 'PLA', { preferBrand: 'Generic' });
    expect(best?.name).toBe('Generic PLA @M');
  });

  it('respects candidate-type order for fallbacks (PCTG prefers PCTG over PETG)', () => {
    const pctgList = [
      preset({ name: 'Some PETG @M', filamentType: 'PETG' }),
      preset({ name: 'Some PCTG @M', filamentType: 'PCTG' })
    ];
    expect(selectFilamentForMaterial(pctgList, 'PCTG')?.name).toBe('Some PCTG @M');
    // when only PETG is present, PCTG falls back to it
    expect(selectFilamentForMaterial([preset({ name: 'Only PETG @M', filamentType: 'PETG' })], 'PCTG')?.name).toBe(
      'Only PETG @M'
    );
  });

  it('filters by machine when asked', () => {
    const mixed = [
      preset({ name: 'on M', filamentType: 'PLA', compatiblePrinters: ['M 0.4 nozzle'] }),
      preset({ name: 'on Z', filamentType: 'PLA', compatiblePrinters: ['Z 0.4 nozzle'] })
    ];
    const ranked = filamentsForMaterial(mixed, 'PLA', { machineName: 'M 0.4 nozzle' });
    expect(ranked.map((f) => f.name)).toEqual(['on M']);
  });

  it('returns nothing for an unmapped material (OTHER) or no match', () => {
    expect(filamentsForMaterial(list, 'OTHER')).toEqual([]);
    expect(selectFilamentForMaterial(list, 'ABS')).toBeNull();
  });

  it('is deterministic (stable order for equal-rank leaves)', () => {
    const a = filamentsForMaterial(list, 'PLA').map((f) => f.name);
    const b = filamentsForMaterial([...list].reverse(), 'PLA').map((f) => f.name);
    expect(a).toEqual(b);
  });
});
