// ---------------------------------------------------------------------------
// generate-printer-database.mjs
//
// Reads Printer_Database/Printer_Database.xlsx (the human-editable source of
// truth) and produces src/data/printers.json (the runtime data the app ships).
//
// Self-contained: parses the .xlsx (a ZIP of XML parts) using only Node
// built-ins (zlib for DEFLATE). No third-party dependencies, so it runs the
// same on Windows, macOS, Linux, and GitHub Actions, and never needs Excel.
//
// Usage:
//   node scripts/generate-printer-database.mjs          # regenerate JSON
//   node scripts/generate-printer-database.mjs --check   # validate only,
//                                                        # fail if JSON is stale
//
// See README → "Updating the Printer Database".
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const XLSX_PATH = join(REPO_ROOT, 'Printer_Database', 'Printer_Database.xlsx');
const OUT_PATH = join(REPO_ROOT, 'src', 'data', 'printers.json');
const SHEET_NAME = 'Printer Specifications';
const SCHEMA_VERSION = 1;

// Bumped whenever the DATA changes in a way saved printer profiles should pick
// up, even though the shape (SCHEMA_VERSION) is unchanged. The app compares a
// profile's stored revision against this and offers to refresh stale specs.
//
//   1 — initial release (1.3.0)
//   2 — 1.3.2: corrected the blank-cell parser bug that corrupted 374 of 379
//       printers, plus a spreadsheet revision with updated specs.
//   3 — workbook cleanup of the 23 entries the new plausibility ranges flagged.
//       Mostly placeholder zeros blanked (no change to the generated output),
//       plus one real correction: a max volumetric flow of 300 mm³/s — about
//       ten times any real hotend — replaced with 15.
//
// Bump this in the SAME commit as any workbook change that alters the
// generated JSON. A published release pins its dataRevision to the exact data
// it shipped, so reusing a number for different data breaks the contract the
// refresh prompt relies on.
const DATA_REVISION = 3;

const CHECK_MODE = process.argv.includes('--check');

// --- minimal ZIP reader ----------------------------------------------------
// .xlsx is a ZIP archive. We read the central directory (which always carries
// accurate sizes and offsets) and inflate the entries we care about.

function readZipEntries(buf) {
  // Locate End Of Central Directory record (signature 0x06054b50), scanning
  // backwards to tolerate a trailing comment.
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx (no ZIP end-of-central-directory record).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = new Map();

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // central dir header sig
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipFile(buf, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`Missing "${name}" inside the workbook.`);
  // Local file header: recompute data start from its own name/extra lengths.
  if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) {
    throw new Error(`Corrupt local header for "${name}".`);
  }
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const dataStart = e.localOffset + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return compressed; // stored
  if (e.method === 8) return inflateRawSync(compressed); // deflate
  throw new Error(`Unsupported ZIP compression method ${e.method} for "${name}".`);
}

// --- minimal XLSX sheet reader ---------------------------------------------

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // ampersand last so we don't double-decode
}

function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) text += tm[1];
    out.push(decodeXml(text));
  }
  return out;
}

/** Resolve the worksheet XML part filename for a given sheet display name. */
function resolveSheetPath(buf, entries, sheetName) {
  const workbook = readZipFile(buf, entries, 'xl/workbook.xml').toString('utf8');
  const rels = readZipFile(buf, entries, 'xl/_rels/workbook.xml.rels').toString('utf8');
  const relMap = new Map();
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let rm;
  while ((rm = relRe.exec(rels))) relMap.set(rm[1], rm[2]);

  const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
  let sm;
  while ((sm = sheetRe.exec(workbook))) {
    if (decodeXml(sm[1]) === sheetName) {
      const target = relMap.get(sm[2]);
      if (!target) break;
      return 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '');
    }
  }
  throw new Error(`Worksheet "${sheetName}" not found in workbook.`);
}

function colLetters(ref) {
  const m = /^([A-Z]+)\d+$/.exec(ref);
  return m ? m[1] : ref.replace(/\d+/g, '');
}

/** Read a worksheet into an array of { rowIndex, cells: { COL: value } }. */
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowIndex = Number(rm[1]);
    const cells = {};
    // Self-closing cells (`<c r="E2" s="2"/>`, i.e. a blank cell) MUST be
    // recognised as such. An earlier pattern alternated `<c\b([^>]*)>...</c>`
    // first, and `[^>]*` happily consumed the trailing `/` — so a blank cell
    // was read as an opening tag whose body ran on to the NEXT cell's `</c>`.
    // That stole the following cell's <v> and, because the borrowed attributes
    // carry no `t="s"`, stored a shared-string INDEX as if it were a number.
    // Blank Max Nozzle Temp cells thus became values like 27 or 69. Matching
    // `/>` before `>` in one alternation keeps the two cases distinct.
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
      const attrs = cm[1] ?? '';
      const body = cm[2] ?? '';
      const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!refM) continue;
      const col = colLetters(refM[1]);
      const tM = /\bt="([^"]+)"/.exec(attrs);
      const type = tM ? tM[1] : 'n';
      let value;
      if (type === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? shared[Number(vM[1])] : undefined;
      } else if (type === 'inlineStr') {
        const tInner = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = tInner ? decodeXml(tInner[1]) : undefined;
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? decodeXml(vM[1]) : undefined;
      }
      if (value !== undefined && String(value).trim() !== '') cells[col] = String(value).trim();
    }
    rows.push({ rowIndex, cells });
  }
  return rows;
}

// --- normalization ---------------------------------------------------------

const warnings = [];
function warn(rowIndex, message) { warnings.push({ row: rowIndex, message }); }

/**
 * Physically plausible ranges for numeric specs. A value outside its range is
 * almost certainly a data-entry slip or a parsing fault, never a real machine —
 * so it is rejected (stored as null, i.e. "not specified") and reported.
 *
 * This exists because the 1.3.0 database shipped 250 printers with a max nozzle
 * temperature of 27 or 69 °C: a blank-cell parser bug was storing shared-string
 * indices as numbers. Nothing caught it, because --check only verified that the
 * JSON matched the workbook — and it faithfully did. Rejecting impossible
 * values turns that class of fault into loud warnings at generation time
 * instead of a silent, shipped regression.
 */
const RANGES = {
  maxNozzleTempC: { min: 150, max: 600, label: 'Max Nozzle Temp' },
  maxBedTempC: { min: 0, max: 200, label: 'Max Bed Temp' },
  maxChamberTempC: { min: 0, max: 150, label: 'Max Chamber Temp' },
  maxVolumetricFlowMm3s: { min: 0.5, max: 200, label: 'Max Volumetric Flow' },
  defaultNozzleDiameterMm: { min: 0.05, max: 3, label: 'Default Nozzle Diameter' },
  buildVolumeX: { min: 1, max: 3000, label: 'Build Volume X' },
  buildVolumeY: { min: 1, max: 3000, label: 'Build Volume Y' },
  buildVolumeZ: { min: 1, max: 3000, label: 'Build Volume Z' },
  maxPrintSpeedMmS: { min: 1, max: 2000, label: 'Max Print Speed' },
  maxAccelerationMmS2: { min: 1, max: 200000, label: 'Max Acceleration' },
  extruderCount: { min: 1, max: 16, label: 'Number of Extruders' },
  releaseYear: { min: 1980, max: 2100, label: 'Release Year' }
};

/**
 * Read a numeric cell. `field` opts into the plausibility check above; omit it
 * for values with no meaningful range. Returns null for blank, unparseable, or
 * out-of-range input so downstream code treats it as "not specified".
 */
function num(raw, rowIndex, label, field) {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(rowIndex, `${label}: "${raw}" is not a number — stored as null.`);
    return null;
  }
  const range = field ? RANGES[field] : undefined;
  if (range && (n < range.min || n > range.max)) {
    warn(rowIndex, `${label}: ${n} is outside the plausible range ${range.min}–${range.max} — stored as null. Check this cell in the workbook.`);
    return null;
  }
  return n;
}

function boolYesNo(raw, rowIndex) {
  if (raw === undefined || raw === '') return null;
  const v = raw.toLowerCase();
  if (v === 'yes' || v === 'true' || v === 'y') return true;
  if (v === 'no' || v === 'false' || v === 'n') return false;
  warn(rowIndex, `Heated Chamber: unexpected value "${raw}" — stored as null.`);
  return null;
}

function normalizeExtruder(raw) {
  if (!raw) return null;
  const v = raw.toLowerCase();
  const hasDirect = v.includes('direct');
  const hasBowden = v.includes('bowden');
  if (hasDirect && hasBowden) return 'mixed';
  if (hasDirect) return 'direct-drive';
  if (hasBowden) return 'bowden';
  return 'unknown';
}

function parseNozzleList(raw, rowIndex) {
  if (!raw) return [];
  // Split on commas, semicolons, slashes and plus signs. Values may carry a
  // variant suffix that we normalize away to the bare diameter, since only the
  // diameter matters for calibration:
  //   "0.4HS" (high-speed) → 0.4,  "0.8HF" (high-flow) → 0.8,  "0.4+0.6" → 0.4, 0.6
  const parts = raw.split(/[,;/+]/).map(s => s.trim()).filter(Boolean);
  const nums = [];
  for (const p of parts) {
    const n = parseFloat(p); // reads a leading number, ignoring a trailing suffix
    if (Number.isFinite(n)) nums.push(n);
    else warn(rowIndex, `Supported Nozzle Sizes: "${p}" has no numeric diameter — skipped.`);
  }
  // Unique, ascending, deterministic.
  return [...new Set(nums)].sort((a, b) => a - b);
}

function slugify(s) {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[+]/g, '-plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function str(raw) {
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Locale-independent, case-insensitive string comparator. Compares lowercased
 * strings by Unicode code point (identical on every JS engine), tie-broken by
 * the raw string so ordering is fully stable and reproducible across machines.
 */
function byText(a, b) {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  if (al < bl) return -1;
  if (al > bl) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- build -----------------------------------------------------------------

function build() {
  const buf = readFileSync(XLSX_PATH);
  const entries = readZipEntries(buf);
  const shared = parseSharedStrings(readZipFile(buf, entries, 'xl/sharedStrings.xml').toString('utf8'));
  const sheetPath = resolveSheetPath(buf, entries, SHEET_NAME);
  const rawRows = parseSheet(readZipFile(buf, entries, sheetPath).toString('utf8'), shared);
  return buildDatabase(rawRows);
}

/**
 * Turn parsed spreadsheet rows into the runtime database. Pure (no file I/O),
 * so tests can drive it with small synthetic fixtures. `rawRows` is an array of
 * { rowIndex, cells: { COL: string } }; row 1 is treated as the header.
 * Returns { data, skippedEmpty, warnings }.
 */
export function buildDatabase(rawRows) {
  warnings.length = 0;
  let skippedEmpty = 0;
  const printers = [];
  const idCounts = new Map();
  const seenMakeModel = new Map();

  for (const { rowIndex, cells } of rawRows) {
    if (rowIndex === 1) continue; // header
    if (Object.keys(cells).length === 0) { skippedEmpty++; continue; }

    const get = (col) => cells[col];
    const manufacturer = str(get('A'));
    const model = str(get('B'));

    if (!manufacturer || !model) {
      // A row with data but no make/model is malformed — do not silently drop.
      warn(rowIndex, `Skipped: missing ${!manufacturer ? 'Manufacturer' : ''}${!manufacturer && !model ? ' and ' : ''}${!model ? 'Printer Model' : ''}.`);
      continue;
    }

    const makeModelKey = `${manufacturer.toLowerCase()}|||${model.toLowerCase()}`;
    if (seenMakeModel.has(makeModelKey)) {
      warn(rowIndex, `Duplicate manufacturer+model "${manufacturer} ${model}" (also row ${seenMakeModel.get(makeModelKey)}). Both kept with distinct ids.`);
    } else {
      seenMakeModel.set(makeModelKey, rowIndex);
    }

    // Stable, readable id with collision suffixing. The model column usually
    // already carries the brand prefix ("Bambu Lab X1 Carbon"), so avoid
    // doubling it — only prepend the manufacturer when it isn't there already.
    const makeSlug = slugify(manufacturer);
    const modelSlug = slugify(model);
    let baseId = (modelSlug === makeSlug || modelSlug.startsWith(makeSlug + '-'))
      ? modelSlug
      : (makeSlug ? `${makeSlug}-${modelSlug}` : modelSlug);
    baseId = baseId || `printer-${rowIndex}`;
    const count = idCounts.get(baseId) ?? 0;
    idCounts.set(baseId, count + 1);
    const id = count === 0 ? baseId : `${baseId}-${count + 1}`;

    const supported = parseNozzleList(get('K'), rowIndex);
    const bx = num(get('L'), rowIndex, 'Build Volume X', 'buildVolumeX');
    const by = num(get('M'), rowIndex, 'Build Volume Y', 'buildVolumeY');
    const bz = num(get('N'), rowIndex, 'Build Volume Z', 'buildVolumeZ');

    const spec = {
      id,
      manufacturer,
      model,
      technology: str(get('C')),
      extruderType: normalizeExtruder(get('D')),
      maxNozzleTempC: num(get('E'), rowIndex, 'Max Nozzle Temp', 'maxNozzleTempC'),
      maxBedTempC: num(get('F'), rowIndex, 'Max Bed Temp', 'maxBedTempC'),
      maxChamberTempC: num(get('G'), rowIndex, 'Max Chamber Temp', 'maxChamberTempC'),
      heatedChamber: boolYesNo(get('H'), rowIndex),
      maxVolumetricFlowMm3s: num(get('I'), rowIndex, 'Max Volumetric Flow', 'maxVolumetricFlowMm3s'),
      defaultNozzleDiameterMm: num(get('J'), rowIndex, 'Default Nozzle Diameter', 'defaultNozzleDiameterMm'),
      supportedNozzleDiametersMm: supported,
      buildVolumeMm: { x: bx, y: by, z: bz },
      maxPrintSpeedMmS: num(get('O'), rowIndex, 'Max Print Speed', 'maxPrintSpeedMmS'),
      maxAccelerationMmS2: num(get('P'), rowIndex, 'Max Acceleration', 'maxAccelerationMmS2'),
      firmware: str(get('Q')),
      extruderCount: num(get('R'), rowIndex, 'Number of Extruders', 'extruderCount'),
      multiMaterialCompatibility: str(get('S')),
      releaseYear: num(get('T'), rowIndex, 'Release Year', 'releaseYear'),
      profileSource: str(get('U')),
      sourceFile: str(get('V')),
      notes: str(get('W'))
    };
    printers.push(spec);
  }

  // Deterministic ordering: manufacturer, then model (case-insensitive).
  // Uses a code-point comparison rather than localeCompare — localeCompare's
  // result depends on the host ICU version, which differs between a dev machine
  // and CI and would make the committed JSON fail `--check` on the runner.
  printers.sort((a, b) =>
    byText(a.manufacturer, b.manufacturer) || byText(a.model, b.model));

  const manufacturers = [...new Set(printers.map(p => p.manufacturer))]
    .sort(byText);

  // No generated timestamp in committed output — it would create needless git
  // churn and make the build nondeterministic. schemaVersion + counts suffice.
  const data = {
    schemaVersion: SCHEMA_VERSION,
    dataRevision: DATA_REVISION,
    source: 'Printer_Database/Printer_Database.xlsx',
    sheet: SHEET_NAME,
    printerCount: printers.length,
    manufacturerCount: manufacturers.length,
    manufacturers,
    printers
  };

  return { data, skippedEmpty, warnings: warnings.slice() };
}

// Exported for tests.
export { slugify, parseNozzleList, boolYesNo, normalizeExtruder, parseSheet, num, SCHEMA_VERSION, DATA_REVISION };

// --- main ------------------------------------------------------------------

function main() {
  let result;
  try {
    result = build();
  } catch (e) {
    console.error(`\n✖ Printer database generation failed: ${e.message}\n`);
    process.exit(1);
  }
  const { data, skippedEmpty } = result;
  const json = JSON.stringify(data, null, 2) + '\n';

  if (CHECK_MODE) {
    let current = '';
    try { current = readFileSync(OUT_PATH, 'utf8'); } catch { /* missing */ }
    // Compare newline-insensitively: git may check the committed file out with
    // CRLF on Windows CI, which must not count as "stale".
    const norm = (s) => s.replace(/\r\n/g, '\n');
    if (norm(current) !== norm(json)) {
      console.error('\n✖ src/data/printers.json is out of date with the workbook.');
      console.error('  Run: npm run generate:printers\n');
      process.exit(1);
    }
    console.log(`✓ printers.json is up to date (${data.printerCount} printers, ${data.manufacturerCount} manufacturers).`);
    if (warnings.length) printWarnings();
    return;
  }

  writeFileSync(OUT_PATH, json);

  console.log('\nPrinter database generated successfully.');
  console.log(`  Manufacturers:      ${data.manufacturerCount}`);
  console.log(`  Printer models:     ${data.printerCount}`);
  console.log(`  Skipped empty rows: ${skippedEmpty}`);
  console.log(`  Warnings:           ${warnings.length}`);
  console.log(`  Output:             src/data/printers.json`);
  if (warnings.length) printWarnings();
  console.log('');
}

function printWarnings() {
  console.log('\nWarnings:');
  for (const w of warnings) console.log(`  Row ${w.row}: ${w.message}`);
}

// Run the CLI only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
