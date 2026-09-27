# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PerfectFit is a local-first, guided wizard for calibrating filament profiles for Orca
Slicer and Bambu Studio. It's a TypeScript/Vite static web app with no backend/accounts/
analytics — all data lives in the browser (IndexedDB + localStorage) — optionally packaged
as a native desktop app via Tauri v2 (Rust). The Tauri layer only adds an *optional* native
integration (direct read/write of slicer profile files on disk); the web app is fully
functional without it.

## Commands

```bash
npm run dev                  # vite dev server, http://localhost:5173
npm run build                # tsc --noEmit, then vite build to dist/
npm test                     # vitest run (all suites)
npm run test:watch           # vitest watch mode
npx vitest run tests/formulas.test.ts   # single suite
npx vitest run -t "test name pattern"   # single test by name

npm run generate:printers    # regenerate src/data/printers.json from the xlsx workbook
npm run validate:printers    # CI check: fails if printers.json is stale vs. the workbook

npm run tauri dev            # desktop app in dev mode (needs Rust toolchain)
npm run tauri build          # native desktop build
```

Rust side (`src-tauri/`): tests are inline `#[cfg(test)]` modules in `backup.rs`,
`install.rs`, `discovery.rs` — run with `cargo test` from `src-tauri/`.

There is no lint script; TypeScript's `strict` mode (via `tsc --noEmit` in `npm run build`)
is the only enforced static check.

## Architecture

### Web app (`src/`) — always available, no native dependency

- `types.ts` — all domain types (printer profiles, calibration ids, etc.)
- `app.ts` / `main.ts` — shell, hash-based router (`#/wizard/:id/:step` etc.), theme, leave-guard
- `data/` — mostly-static content treated as data, not code:
  - `calibrations.ts` — the 7 calibration test definitions
  - `slicers.ts` — **version-aware** per-slicer instructions (Orca 2.4.x, Bambu 1.7+), each
    entry carries a `verifiedOn` date. Updating for a new slicer release means editing one
    data entry here, not code.
  - `materials.ts` — material presets (suggestions only, always editable)
  - `printerDatabase.ts` / `printers.json` — see "Printer database" below
  - `glossary.ts`, `models.ts` (external 3D model manifest)
- `logic/` — pure calculation/validation, decoupled from UI:
  - `formulas.ts` — the formula engine; every calculation returns
    inputs/formula/result/warnings (no black-box numbers anywhere in the UI)
  - `ranges.ts` — suggested test ranges derived from material + printer + extruder
  - `validation.ts`, `confidence.ts`, `recommendations.ts`
- `storage/` — IndexedDB wrapper + repository (`db.ts`), settings/drafts (`store.ts`)
- `export/backup.ts` — JSON export/import with schema versioning and migration
- `ui/` — one module per view/screen (dashboard, printers, project, wizard, forms, report,
  card, settings…), built on a tiny custom `h()`/DOM helper (`ui/dom.ts`) — no framework

**Adding a calibration test** = new entry in `data/calibrations.ts` + a form controller in
`ui/testForms.ts` + slicer steps in `data/slicers.ts`. No page redesign needed.

### Slicer integration (`src/slicerIntegration/`) — desktop-only, degrades to no-op on web

This subsystem lets the desktop app read/write Orca-family slicer profile files directly on
disk (scan installed slicers, install a generated preset, back up/restore user presets before
overwriting them). It is optional and gated behind `isDesktop()`.

- `bridge.ts` is **the single boundary** between web-safe code and native Tauri commands —
  everything else in this directory must go through it, so the browser/PWA build degrades
  cleanly to export-only behavior. It calls through `window.__TAURI__` (no Tauri npm
  dependency in the frontend bundle). Command names/payload shapes here must mirror
  `src-tauri/src/slicer_integration/` (serde snake_case on the Rust side, camelCase args here).
- `registry.ts` / `orcaFamily.ts` / `adapters/` — per-slicer adapters (Orca, Bambu, Elegoo
  Slicer, FlashPrint/FlashStudio, Snapmaker Orca) describing profile locations and formats
  for the Orca-derived slicer family.
- `scanner.ts`, `generator.ts`, `diff.ts`, `validation.ts`, `installer.ts`,
  `recommendations.ts`, `diagnostics.ts`, `errors.ts` — scan existing profiles, generate a
  new preset from wizard results, diff/validate before writing, and produce the install plan.
- `libraryBackup.ts`, `featureFlags.ts` — experimental features are gated by flags persisted
  under a separate localStorage key (`perfectfit.experimentalFeatures`) so they never touch
  `AppSettings` or its backups.
- Fixtures for this subsystem's tests live in `tests/slicerIntegration/fixtures/` — real
  sampled profile JSON/info files from each supported slicer, used to test adapters/scanner/
  generator against actual on-disk formats rather than synthetic data.

### Desktop shell (`src-tauri/`)

Rust/Tauri v2 backend. `src/slicer_integration/` (`discovery`, `filesystem`, `processes`,
`backup`, `install`, `security`) implements the native commands that `bridge.ts` calls —
detecting installed slicers, scanning/writing profile files, backing up user presets before
overwrite, launching the slicer executable. `lib.rs` also carries two narrow
platform-specific workarounds applied at startup: purging stale webview caches on Windows
(prevents old service-worker/cache entries from wedging updates on a hashed-bundle mismatch)
and disabling WebKitGTK's DMABUF renderer on Linux (works around a blank-window bug on some
Wayland setups). Both are guarded so an explicit user override still wins.

### Printer database

`Printer_Database/Printer_Database.xlsx` (worksheet **Printer Specifications**) is the
source of truth for the printer picker's known-printer specs. `src/data/printers.json` is
the generated, *committed* runtime artifact — CI does not regenerate it, so the committed
JSON is what actually ships. Workflow when editing printer data:

1. Edit the xlsx (keep existing column order; the `Data Sources` sheet is provenance-only
   and ignored by the generator).
2. `npm run generate:printers` and review the printed warnings.
3. `npm test`.
4. Commit **both** the workbook and `src/data/printers.json`.

Rules the generator enforces (see `scripts/generate-printer-database.mjs`): blank cells
become `null`/omitted (never `0`) so the UI can render "Not specified"; duplicate
manufacturer+model rows get warned and suffixed ids; ids are stable slugs
(`bambu-lab-x1-carbon`) and must **never be renamed** when a row's other fields change,
since saved user printers reference the id — for a renamed/discontinued model, keep the row
and id and note the change in the Notes column instead. Output is deterministic (sorted, no
timestamp) for clean diffs. `npm run validate:printers` (used in CI) fails if the committed
JSON is stale relative to the workbook.

## Conventions

- No dependencies beyond what's already in `package.json`/`Cargo.toml` without a clear
  reason — this is a deliberately dependency-light, local-first app (no analytics, no
  telemetry, no accounts, no cloud sync).
- `vite.config.ts` uses `base: './'` — the built app must keep working from any subpath
  (Nginx, Apache, `file://` preview, and Tauri all serve it). Don't introduce absolute-root
  paths.
- Preserve behavior parity between Orca Slicer and Bambu Studio unless a change is
  intentionally slicer-specific; when shared behavior changes, check both instruction paths
  in `data/slicers.ts`.
- Instructions/wording for slicer steps are versioned data (`verifiedOn` dates in
  `data/slicers.ts`), not hardcoded strings scattered through the UI — treat a slicer-version
  bump as a data update, and check `docs/RESEARCH.md` for the sourcing/verification notes
  behind current values.
- Keep comments to the "why", matching the existing style (see `bridge.ts`, `lib.rs` for
  examples) — the codebase already avoids narrating "what" the code does.
