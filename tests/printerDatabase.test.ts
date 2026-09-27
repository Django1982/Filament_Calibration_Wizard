import { describe, it, expect } from 'vitest';
// The generator is plain ESM (Node built-ins only); vitest imports it directly.
import {
  buildDatabase, slugify, parseNozzleList, boolYesNo, normalizeExtruder, parseSheet, num,
  DATA_REVISION
} from '../scripts/generate-printer-database.mjs';
import {
  allPrinterSpecs, getPrinterSpec, groupedPrinterSpecs, profileValuesFromSpec, specLabel,
  isSpecRefreshAvailable, specChangesForProfile, refreshProfileFromDatabase, PRINTER_DB_DATA_REVISION
} from '../src/data/printerDatabase';
import { migrate } from '../src/export/backup';
import { validateAgainstPrinter } from '../src/logic/validation';
import type { BackupFile, PrinterProfile, PrinterDatabase } from '../src/types';

interface BuildResult {
  data: PrinterDatabase;
  skippedEmpty: number;
  warnings: { row: number; message: string }[];
}

// A tiny header row + realistic records across several manufacturers, plus the
// awkward cases the parser must survive. Columns follow the workbook layout.
const HEADER = {
  rowIndex: 1,
  cells: {
    A: 'Manufacturer', B: 'Printer Model', C: 'Technology', D: 'Extruder Type',
    E: 'Max Nozzle Temp (C)', F: 'Max Bed Temp (C)', G: 'Max Chamber Temp (C)',
    H: 'Heated Chamber', I: 'Max Volumetric Flow (mm3/s)', J: 'Default Nozzle Diameter (mm)',
    K: 'Supported Nozzle Sizes (mm)', L: 'Build Volume X (mm)', M: 'Build Volume Y (mm)',
    N: 'Build Volume Z (mm)', O: 'Max Print Speed (mm/s)', P: 'Max Acceleration (mm/s2)',
    Q: 'Firmware', R: 'Number of Extruders', S: 'AMS/MMU Compatibility', T: 'Release Year',
    U: 'Profile Source', V: 'Source File', W: 'Notes'
  }
};

function row(rowIndex: number, cells: Record<string, string>) {
  return { rowIndex, cells };
}

const FIXTURE = [
  HEADER,
  row(2, {
    A: 'Bambu Lab', B: 'Bambu Lab X1 Carbon', C: 'FFF', D: 'Direct Drive',
    E: '300', F: '110', G: '60', H: 'Yes', I: '24', J: '0.4', K: '0.2, 0.4, 0.6, 0.8',
    L: '256', M: '256', N: '256', O: '500', P: '20000', Q: 'Proprietary', R: '1',
    S: 'AMS', T: '2022', U: 'Bambu Studio', V: 'BBL/machine/X1C.json', W: ''
  }),
  row(3, {
    A: 'Creality', B: 'Ender-3 V3 KE', C: 'FFF', D: 'Direct Drive',
    E: '300', F: '100', H: 'No', I: '17', J: '0.4', K: '0.4',
    L: '220', M: '220', N: '240', O: '500', P: '8000', Q: 'Klipper', R: '1', T: '2023',
    U: 'OrcaSlicer', V: 'Creality/machine/KE.json'
  }),
  // Bowden + suffixed/plus nozzle list + missing many optional fields.
  row(4, { A: 'Anycubic', B: 'Anycubic Kobra', D: 'Bowden', K: '0.4HS, 0.6+0.8' }),
  row(5, { /* completely empty */ }),
  // Duplicate manufacturer+model of row 2.
  row(6, { A: 'Bambu Lab', B: 'Bambu Lab X1 Carbon', E: '300' }),
  // Malformed: data present but no manufacturer/model.
  row(7, { E: '250', F: '90' }),
  // Zero is a valid value and must be preserved (not dropped as "empty").
  row(8, { A: 'Zeta', B: 'Zeta Zero', G: '0', F: '0' })
];

describe('printer database generation', () => {
  const { data, skippedEmpty, warnings } = buildDatabase(FIXTURE) as BuildResult;

  it('parses valid rows and skips the fully-empty one', () => {
    expect(skippedEmpty).toBe(1);
    // rows 2,3,4,6,8 become printers (row 7 dropped: no make/model).
    expect(data.printerCount).toBe(5);
  });

  it('converts numbers, keeping valid zeros', () => {
    const x1c = data.printers.find(p => p.model === 'Bambu Lab X1 Carbon' && p.maxNozzleTempC === 300)!;
    expect(x1c.maxNozzleTempC).toBe(300);
    expect(x1c.buildVolumeMm).toEqual({ x: 256, y: 256, z: 256 });
    const zeta = data.printers.find(p => p.manufacturer === 'Zeta')!;
    expect(zeta.maxChamberTempC).toBe(0);   // zero preserved
    expect(zeta.maxBedTempC).toBe(0);
  });

  it('normalizes Yes/No to booleans and blanks to null', () => {
    expect(boolYesNo('Yes', 1)).toBe(true);
    expect(boolYesNo('No', 1)).toBe(false);
    expect(boolYesNo('', 1)).toBe(null);
    const ke = data.printers.find(p => p.model === 'Ender-3 V3 KE')!;
    expect(ke.heatedChamber).toBe(false);
  });

  it('parses supported nozzle sizes, including suffixed and combined forms', () => {
    expect(parseNozzleList('0.2, 0.4, 0.6, 0.8', 1)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(parseNozzleList('0.4HS, 0.6+0.8', 1)).toEqual([0.4, 0.6, 0.8]);
    expect(parseNozzleList('', 1)).toEqual([]);
  });

  it('normalizes extruder types', () => {
    expect(normalizeExtruder('Direct Drive')).toBe('direct-drive');
    expect(normalizeExtruder('Bowden')).toBe('bowden');
    expect(normalizeExtruder('Direct Drive (main) / Bowden (aux)')).toBe('mixed');
    expect(normalizeExtruder('')).toBe(null);
  });

  it('omits unknown optional fields rather than inventing values', () => {
    const kobra = data.printers.find(p => p.manufacturer === 'Anycubic')!;
    expect(kobra.maxNozzleTempC).toBe(null);
    expect(kobra.firmware).toBe(null);
    expect(kobra.buildVolumeMm).toEqual({ x: null, y: null, z: null });
  });

  it('creates stable, unique, readable ids and de-doubles the brand prefix', () => {
    const ids = data.printers.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);          // all unique
    expect(ids).toContain('bambu-lab-x1-carbon');
    expect(ids).toContain('creality-ender-3-v3-ke');
    // The duplicate row gets a suffixed id, not a collision.
    expect(ids.filter(i => i.startsWith('bambu-lab-x1-carbon')).sort())
      .toEqual(['bambu-lab-x1-carbon', 'bambu-lab-x1-carbon-2']);
    expect(slugify('QIDI Plus4')).toBe('qidi-plus4');
  });

  it('warns about duplicates and malformed rows instead of dropping silently', () => {
    const text = warnings.map(w => `${w.row}:${w.message}`).join('\n');
    expect(text).toMatch(/Duplicate manufacturer\+model/);
    expect(text).toMatch(/7:.*missing/i);
  });

  it('sorts manufacturers and models alphabetically', () => {
    expect(data.manufacturers).toEqual([...data.manufacturers].sort(
      (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });
});

describe('printer database service (real printers.json)', () => {
  it('ships a non-trivial, well-formed database', () => {
    const all = allPrinterSpecs();
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all.map(p => p.id)).size).toBe(all.length);
  });

  it('groups by manufacturer with alphabetical models and supports search', () => {
    const groups = groupedPrinterSpecs('bambu');
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every(g => g.manufacturer.toLowerCase().includes('bambu') ||
      g.printers.every(p => p.model.toLowerCase().includes('bambu')))).toBe(true);
    // Model search should also hit even when the brand doesn't match the query.
    const byModel = groupedPrinterSpecs('X1 Carbon');
    expect(byModel.some(g => g.printers.some(p => /x1 carbon/i.test(p.model)))).toBe(true);
  });

  it('auto-populates profile values and omits unknown fields (never 0)', () => {
    const spec = allPrinterSpecs().find(p => p.maxChamberTempC == null)!;
    const v = profileValuesFromSpec(spec);
    expect('maxChamberTemp' in v).toBe(false);       // unknown → omitted, not 0
    expect(v.isManual).toBe(false);
    expect(v.databasePrinterId).toBe(spec.id);

    const full = getPrinterSpec('bambu-lab-x1-carbon')!;
    const fv = profileValuesFromSpec(full);
    expect(fv.manufacturer).toBe('Bambu Lab');
    expect(fv.maxNozzleTemp).toBe(300);
    expect(fv.extruderType).toBe('direct');          // mapped from 'direct-drive'
    expect(fv.supportedNozzleDiameters).toContain(0.4);
    expect(specLabel(full)).toContain('Bambu Lab');
  });
});

describe('backward compatibility / migration', () => {
  it('migrates a v3 backup to v4 and flags pre-existing printers as manual', () => {
    const oldPrinter = {
      id: 'p1', name: 'My Ender', manufacturer: 'Creality', nozzleDiameter: 0.4,
      maxNozzleTemp: 260, maxBedTemp: 100, extruderType: 'bowden',
      retractionRange: { start: 0, end: 2 }, notes: '', createdAt: 'x', updatedAt: 'x'
    } as unknown as PrinterProfile;
    const file = {
      app: 'perfectfit-filament-calibration-wizard', schemaVersion: 3,
      exportedAt: '2026-01-01T00:00:00Z', projects: [], printers: [oldPrinter]
    } as unknown as BackupFile;
    const out = migrate(file);
    expect(out.schemaVersion).toBe(5);
    expect(out.printers[0].isManual).toBe(true);
    // Existing values are preserved, not reset.
    expect(out.printers[0].maxNozzleTemp).toBe(260);
    expect(out.printers[0].nozzleDiameter).toBe(0.4);
  });
});

describe('safe-limit validation against printer specs', () => {
  const printer = {
    id: 'x', name: 'X', manufacturer: 'B', nozzleDiameter: 0.4,
    maxNozzleTemp: 300, maxBedTemp: 110, maxVolumetricFlow: 24, extruderType: 'direct',
    retractionRange: { start: 0, end: 1 }, notes: '', createdAt: '', updatedAt: ''
  } as PrinterProfile;

  it('errors when a temperature exceeds the printer maximum', () => {
    expect(validateAgainstPrinter('nozzleTemp', 320, printer).some(i => i.level === 'error')).toBe(true);
    expect(validateAgainstPrinter('nozzleTemp', 250, printer)).toHaveLength(0);
    expect(validateAgainstPrinter('bedTemp', 130, printer).some(i => i.level === 'error')).toBe(true);
  });

  it('warns (not errors) when MVS exceeds the rated flow', () => {
    const issues = validateAgainstPrinter('mvs', 30, printer);
    expect(issues.some(i => i.level === 'warning')).toBe(true);
  });
});

describe('worksheet cell parsing', () => {
  // Regression: a blank cell is written by Excel as a self-closing <c .../>.
  // The original pattern tried `<c\b([^>]*)>...</c>` first, and `[^>]*` ate the
  // trailing `/`, so a blank cell was parsed as an opening tag whose body ran
  // on to the NEXT cell's </c>. That stole the following cell's <v>, and since
  // the borrowed attributes carry no t="s", a shared-string INDEX was stored as
  // a number — blank "Max Nozzle Temp" cells became values like 27 and 69,
  // which then clamped calibration ranges and hard-blocked real temperatures.
  const shared = ['Afinia', 'Afinia H+1(HS)', 'FFF', 'Direct Drive', 'No'];

  function rowXml(cells: string): string {
    return `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Manufacturer</t></is></c></row>` +
      `<row r="2">${cells}</row></sheetData>`;
  }

  it('treats a self-closing cell as blank without stealing the next cell', () => {
    const xml = rowXml(
      '<c r="A2" s="2" t="s"><v>0</v></c>' +
      '<c r="B2" s="2" t="s"><v>1</v></c>' +
      '<c r="C2" s="2" t="s"><v>2</v></c>' +
      '<c r="D2" s="2" t="s"><v>3</v></c>' +
      '<c r="E2" s="2"/>' +          // blank Max Nozzle Temp
      '<c r="F2" s="2"/>' +          // blank Max Bed Temp
      '<c r="G2" s="2"/>' +          // blank Max Chamber Temp
      '<c r="H2" s="2" t="s"><v>4</v></c>'   // Heated Chamber = "No"
    );
    const rows = parseSheet(xml, shared);
    const row = rows.find(r => r.rowIndex === 2)!;

    expect(row.cells.D).toBe('Direct Drive');
    // The three blanks must be absent — never 4 (the shared-string index of H2).
    expect(row.cells.E).toBeUndefined();
    expect(row.cells.F).toBeUndefined();
    expect(row.cells.G).toBeUndefined();
    // ...and H must resolve through the shared-string table, not as a raw index.
    expect(row.cells.H).toBe('No');
  });

  it('still reads numeric and shared-string cells that follow a blank', () => {
    const xml = rowXml('<c r="A2" s="2"/><c r="B2" s="2"><v>300</v></c>');
    const row = parseSheet(xml, shared).find(r => r.rowIndex === 2)!;
    expect(row.cells.A).toBeUndefined();
    expect(row.cells.B).toBe('300');
  });
});

describe('implausible-value guardrails', () => {
  // The 1.3.0 database shipped 250 printers with a max nozzle temp of 27 or
  // 69 C. --check could not catch it: the JSON faithfully matched the workbook,
  // which is exactly why a plausibility floor is needed on top of it.
  it('rejects physically impossible values and explains which cell to fix', () => {
    expect(num('27', 5, 'Max Nozzle Temp', 'maxNozzleTempC')).toBe(null);
    expect(num('69', 5, 'Max Nozzle Temp', 'maxNozzleTempC')).toBe(null);
    expect(num('300', 5, 'Max Nozzle Temp', 'maxNozzleTempC')).toBe(300);
    expect(num('300', 5, 'Max Volumetric Flow', 'maxVolumetricFlowMm3s')).toBe(null);
    expect(num('24', 5, 'Max Volumetric Flow', 'maxVolumetricFlowMm3s')).toBe(24);
  });

  it('leaves unranged fields and blanks alone', () => {
    expect(num('', 5, 'Anything')).toBe(null);
    expect(num('99999', 5, 'Unranged field')).toBe(99999);
  });

  it('keeps zero where zero is meaningful (an unheated bed or chamber)', () => {
    expect(num('0', 5, 'Max Bed Temp', 'maxBedTempC')).toBe(0);
    expect(num('0', 5, 'Max Chamber Temp', 'maxChamberTempC')).toBe(0);
    // ...but not where it is meaningless.
    expect(num('0', 5, 'Max Print Speed', 'maxPrintSpeedMmS')).toBe(null);
  });

  it('ships a database with no impossible nozzle temperatures', () => {
    const bad = allPrinterSpecs().filter(p => p.maxNozzleTempC != null && p.maxNozzleTempC < 150);
    expect(bad).toEqual([]);
  });
});

describe('refreshing saved profiles after a database correction', () => {
  const spec = getPrinterSpec('bambu-lab-x1-carbon')!;
  const stale: PrinterProfile = {
    ...(profileValuesFromSpec(spec) as PrinterProfile),
    id: 'saved-1', name: 'My X1C', nozzleDiameter: 0.4,
    retractionRange: { start: 0, end: 2 }, notes: 'hardened nozzle',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    maxNozzleTemp: 27,              // the 1.3.0 corruption
    databaseDataRevision: undefined  // profiles saved before 1.3.2 carry none
  };

  it('offers a refresh for profiles filled from an older database revision', () => {
    expect(isSpecRefreshAvailable(stale)).toBe(true);
    // A profile already on the current revision is left alone.
    expect(isSpecRefreshAvailable({ ...stale, databaseDataRevision: PRINTER_DB_DATA_REVISION })).toBe(false);
    // Manual printers were never database-filled, so there is nothing to refresh.
    expect(isSpecRefreshAvailable({ ...stale, isManual: true, databasePrinterId: null })).toBe(false);
  });

  it('treats a missing revision as revision 1 and never refreshes downwards', () => {
    expect(isSpecRefreshAvailable({ ...stale, databaseDataRevision: 1 }))
      .toBe(isSpecRefreshAvailable({ ...stale, databaseDataRevision: undefined }));
    // A profile restored from a backup made on a newer build is ahead of the
    // shipped data — offering to "refresh" it would move it backwards.
    expect(isSpecRefreshAvailable({ ...stale, databaseDataRevision: PRINTER_DB_DATA_REVISION + 1 })).toBe(false);
  });

  it('ships a database stamped with the generator\'s current data revision', () => {
    // Bumping DATA_REVISION without regenerating (or editing the workbook
    // without bumping) leaves stale profiles never offered a refresh at all.
    expect(PRINTER_DB_DATA_REVISION).toBe(DATA_REVISION);
  });

  it('reports nothing when a revised database left this printer untouched', () => {
    // Two independent gates: a newer revision AND an actual field difference.
    // Most printers are unaffected by any given correction, so an old revision
    // alone must not produce a callout.
    const untouched: PrinterProfile = { ...refreshProfileFromDatabase(stale), databaseDataRevision: 1 };
    expect(isSpecRefreshAvailable(untouched)).toBe(true);
    expect(specChangesForProfile(untouched)).toEqual([]);
  });

  it('never reports or overwrites a field the database has no value for', () => {
    // A spec the database is silent about (here: chamber temperature) must not
    // be diffed against "not specified" — that would offer to discard a value
    // the user measured on modified hardware.
    const sparse = allPrinterSpecs().find(p => p.maxChamberTempC == null)!;
    const handTuned: PrinterProfile = {
      ...stale, ...(profileValuesFromSpec(sparse) as PrinterProfile),
      databaseDataRevision: 1, maxChamberTemp: 50
    };
    expect(specChangesForProfile(handTuned).some(c => c.key === 'maxChamberTemp')).toBe(false);
    expect(refreshProfileFromDatabase(handTuned).maxChamberTemp).toBe(50);
  });

  it('degrades quietly when the referenced database record is gone', () => {
    // Database ids are permanent by contract, but a renamed one must leave the
    // saved profile usable rather than blanking its specs.
    const orphan: PrinterProfile = { ...stale, databasePrinterId: 'no-such-printer-9000' };
    expect(isSpecRefreshAvailable(orphan)).toBe(false);
    expect(specChangesForProfile(orphan)).toEqual([]);
    expect(refreshProfileFromDatabase(orphan)).toBe(orphan);
  });

  it('reports the differing fields with before/after values', () => {
    const changes = specChangesForProfile(stale);
    const nozzle = changes.find(c => c.key === 'maxNozzleTemp')!;
    expect(nozzle.from).toBe('27 °C');
    expect(nozzle.to).toBe('300 °C');
  });

  it('refreshes specs while preserving identity and user-owned fields', () => {
    const fresh = refreshProfileFromDatabase(stale);
    expect(fresh.maxNozzleTemp).toBe(300);
    expect(fresh.databaseDataRevision).toBe(PRINTER_DB_DATA_REVISION);
    // Identity preserved so projects referencing this printer stay linked.
    expect(fresh.id).toBe('saved-1');
    // User-owned fields untouched.
    expect(fresh.name).toBe('My X1C');
    expect(fresh.notes).toBe('hardened nozzle');
    expect(fresh.retractionRange).toEqual({ start: 0, end: 2 });
    expect(fresh.createdAt).toBe('2026-01-01T00:00:00.000Z');
    // Nothing left to offer afterwards.
    expect(isSpecRefreshAvailable(fresh)).toBe(false);
  });

  it('keeps the id however many specs change, and never mutates the saved profile', () => {
    const corrupted: PrinterProfile = {
      ...stale, maxBedTemp: 27, maxVolumetricFlow: 1, nozzleDiameter: 0.2,
      supportedNozzleDiameters: [0.2], buildVolume: { x: 1, y: 1, z: 1 },
      extruderType: 'bowden', firmware: 'wrong'
    };
    const changed = specChangesForProfile(corrupted).map(c => c.key);
    expect(changed).toEqual(expect.arrayContaining(
      ['maxNozzleTemp', 'maxBedTemp', 'buildVolume', 'extruderType', 'firmware']));

    const fresh = refreshProfileFromDatabase(corrupted);
    expect(fresh.id).toBe('saved-1');
    // The caller persists the returned copy; the original must be left intact
    // so a cancelled refresh cannot have already changed anything.
    expect(corrupted.maxBedTemp).toBe(27);
    expect(corrupted.buildVolume).toEqual({ x: 1, y: 1, z: 1 });
    fresh.retractionRange.end = 9;
    expect(corrupted.retractionRange.end).toBe(2);
  });
});
