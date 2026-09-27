# PerfectFit — Filament Calibration Wizard

> [!NOTE]
> **Status: maintenance mode.** I'm no longer adding features here. My calibration work has
> moved into **[Forca Slicer](https://github.com/tayloraaron078-tech/ForcaSlicer)**, a free
> OrcaSlicer fork with a guided, more automated Calibration Wizard built into the slicer
> (Windows alpha for now). PerfectFit keeps working for stock OrcaSlicer and Bambu Studio;
> bug reports are still welcome, but expect slower fixes.

Create a perfectly calibrated filament profile for Orca Slicer or Bambu Studio in one guided workflow. No tutorials, no guesswork, no spreadsheets.

<img width="1148" height="1007" alt="Hero" src="https://github.com/user-attachments/assets/f56b6877-6558-460a-9df0-097523c63046" />

A local-first web app that walks you step by step through calibrating a filament profile
for **Orca Slicer** (default) or **Bambu Studio** — temperature, flow ratio (two passes),
pressure advance, retraction, max volumetric speed, and a final verification print —
without tutorials, wikis, or guesswork.

- **Coach Mode**: plain-language guidance, good/bad examples, "I'm not sure" decision helpers,
  confidence checks, adaptive troubleshooting.
- **Expert Mode**: condensed flow — ranges, formulas, destinations.
- **No black boxes**: every calculation shows inputs, formula, substitution, and rounding.
- **Signature features**: calibration timeline, confidence score, smart retest recommendations,
  printable one-page calibration card with QR, printable full report, JSON backup/restore.
- **Privacy**: no account, no backend, no analytics/telemetry. Everything (photos included)
  stays in your browser's local storage. External model links open third-party sites.

<img width="1102" height="831" alt="Create Project" src="https://github.com/user-attachments/assets/36fc37fd-c053-4746-814b-48919f965853" />

## Requirements

- Node.js 18+ (for development/build only — the built app is static files)

## Install & run (development)

```bash
npm install
npm run dev          # http://localhost:5173
```

## Tests

```bash
npm test             # vitest: formulas, ranges, numbering, margins, import/export, migration, validation
```

A human-workflow checklist lives in [docs/MANUAL_TEST_CHECKLIST.md](docs/MANUAL_TEST_CHECKLIST.md).

<img width="1103" height="835" alt="Wizard Page" src="https://github.com/user-attachments/assets/6ed5ee39-3db5-4761-bfb9-c39a10259c3d" />

## Production build

```bash
npm run build        # typechecks, then bundles to dist/
npm run preview      # serve the production bundle locally
```

`dist/` is fully static and uses relative paths — it works from any folder or subpath.

## Updating the Printer Database

The Add Printer screen lets users pick from a database of known printers, which
auto-fills the machine specs (temperature limits, extruder type, build volume,
supported nozzle sizes, chamber, firmware…). That database is generated from a
human-editable spreadsheet and committed as JSON, so no build tooling or Excel
is needed at runtime.

**Source of truth:** [`Printer_Database/Printer_Database.xlsx`](Printer_Database/Printer_Database.xlsx)
→ worksheet **`Printer Specifications`**.
**Runtime data:** [`src/data/printers.json`](src/data/printers.json) (committed;
bundled into the app).
**Generator:** [`scripts/generate-printer-database.mjs`](scripts/generate-printer-database.mjs)
(plain Node, no dependencies — works on Windows, macOS, Linux, and CI).

To add or change a printer:

1. Open `Printer_Database/Printer_Database.xlsx`.
2. Add or edit a row on the **Printer Specifications** sheet. Keep the existing
   column order (see below). The `Data Sources` sheet is provenance only and is
   ignored by the generator.
3. Save the workbook.
4. Regenerate the runtime data and review the printed warnings:
   ```bash
   npm run generate:printers
   ```
5. Run the tests:
   ```bash
   npm test
   ```
6. Commit **both** the workbook and `src/data/printers.json`. The next release
   build picks them up automatically — CI does not regenerate the JSON, so the
   committed file is what ships.

Validate without changing the committed file (used in CI / pre-release):

```bash
npm run validate:printers   # exits non-zero if printers.json is stale
```

### Column reference

| Column | Field | Notes |
| --- | --- | --- |
| Manufacturer | required | brand |
| Printer Model | required | may include the brand prefix; the id de-duplicates it |
| Technology | optional | e.g. FFF |
| Extruder Type | optional | `Direct Drive` → `direct-drive`, `Bowden` → `bowden`, mixed → `mixed` |
| Max Nozzle/Bed/Chamber Temp (C) | optional | numbers |
| Heated Chamber | optional | `Yes`/`No` → boolean; blank → unknown |
| Max Volumetric Flow (mm3/s) | optional | number |
| Default Nozzle Diameter (mm) | optional | number |
| Supported Nozzle Sizes (mm) | optional | comma list, e.g. `0.2, 0.4, 0.6`; suffixes like `0.4HS` and `0.4+0.6` are read as their diameters |
| Build Volume X/Y/Z (mm) | optional | numbers |
| Max Print Speed / Acceleration | optional | numbers |
| Firmware, Number of Extruders, AMS/MMU Compatibility, Release Year, Profile Source, Source File, Notes | optional | passed through |

**Rules the generator enforces:**

- **Blank vs. unknown:** empty cells become `null` (or are omitted). A real `0`
  is preserved. The app renders unknown values as “Not specified”, never `0`.
- **Duplicates:** rows with the same manufacturer + model are flagged as
  warnings and each is kept with a distinct id (`…-2`, `…-3`).
- **Empty rows** are skipped; **rows with data but no manufacturer/model** are
  reported as warnings, never silently dropped.
- **IDs** are stable, readable slugs derived from manufacturer + model
  (`bambu-lab-x1-carbon`, `creality-ender-3-v3-ke`), with collision suffixing.
  Never rename an id when you edit a row’s other fields — saved user printers
  reference it. For a **renamed or discontinued** model, keep the row (and its
  id) and note the change in the Notes column rather than deleting it, so
  existing profiles keep their database link.
- Output is **deterministic** (sorted, no timestamp) so regeneration produces a
  clean diff.

## Hosting on Nginx

```nginx
server {
    listen 80;
    server_name calibration.example.lan;
    root /var/www/perfectfit/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Copy the contents of `dist/` to the `root` directory — nothing else is needed
(no PHP, no database). Apache works identically (`DocumentRoot` at `dist/`).
Served over HTTP(S), the app also installs as a PWA and works offline after first load.

> Data is stored per-browser (IndexedDB + localStorage) under the origin you serve from.
> Moving the app to a different domain/port means starting fresh — export a backup first
> and restore it from Settings.

## Docker

The repository ships a `Dockerfile` and an `example-docker-compose.yaml` for
running the app as a container. The image is a multi-stage build: Node builds
the static bundle, which is then served by a tiny BusyBox `httpd` — no Node,
backend, or database in the runtime layer.

```bash
docker build -t perfectfit:latest .
docker run -d -p 8080:80 --name perfectfit perfectfit:latest   # http://localhost:8080
```

`example-docker-compose.yaml` is a sample stack for reverse-proxying the
container behind [Traefik](https://traefik.io/) with automatic Let's Encrypt
TLS. Adjust the `Host(...)` rule, network, and image name to match your setup.
No prebuilt image is published to a registry, so run Compose from a clone of this
repository (`docker compose -f example-docker-compose.yaml up -d --build`) — or build the
image first as shown above. Otherwise Docker fails with "pull access denied for perfectfit".
Because the app uses hash-based routing and relative paths, the static server
needs no SPA-fallback configuration.

> The same per-origin storage note from the Nginx section applies: data lives
> in the browser under the origin you serve from.

## Packaging as a desktop app (Tauri)

Tauri v2 wraps the static build in a small native shell (preferred over Electron: ~10 MB vs ~150 MB).

```bash
# prerequisites: Rust toolchain (rustup) plus the OS-specific Tauri prerequisites for Windows, macOS, or Linux
npm install -D @tauri-apps/cli
npx tauri init
#   ✔ app name: PerfectFit
#   ✔ dev server URL: http://localhost:5173
#   ✔ frontend dist: ../dist
#   ✔ before dev command: npm run dev
#   ✔ before build command: npm run build
npx tauri dev      # develop inside the native window
npx tauri build    # produces the native app plus configured bundles for the current OS
```

No code changes are required — the app already avoids absolute URLs and needs no server.
Inside Tauri, data persists in the WebView's local storage; the JSON backup/restore in
Settings is the supported migration path between browser and desktop builds.

## Data storage & backups

| What | Where |
|---|---|
| Projects, printer profiles, photos | IndexedDB (`perfectfit-db`) |
| Settings, in-progress form drafts | localStorage |
| Backups | JSON files you export (Settings → Backup) |

- **Backup**: Settings → *Export all data* (optionally with photos, base64-embedded).
- **Restore**: Settings → *Restore from backup*. Imports never overwrite: colliding ids
  are imported as copies.
- Single projects can be exported/imported from the dashboard (printer profile embedded).
- Clearing browser site data deletes everything — back up first.

## Model licensing

Orca Slicer generates **all six core calibration tests in-slicer** — no model downloads are
required. Optional external models (3DBenchy for verification; stringing/extrusion tests for
fallback-model gaps) are **linked, not bundled**, because their licenses (e.g. CC BY-ND for
3DBenchy) don't clearly permit redistribution inside an app. See
[public/models/manifest.json](public/models/manifest.json) for source, license, and attribution
of each entry.

## Slicer version compatibility

Instructions are **version-aware data**, not code: `src/data/slicers.ts` holds per-slicer,
per-version content with a `verifiedOn` date (currently: Orca Slicer **2.4.x**, verified
2026-07-18 against the official wiki; Bambu Studio **1.7+**). Updating for a new release
means editing/adding one data entry. Research notes with sources and verified formulas:
[docs/RESEARCH.md](docs/RESEARCH.md).

**Assumptions worth re-verifying when a new slicer version ships:**
- Calibration menu still at top bar → `Calibration` (Orca) / `Calibration` tab plus the Develop Mode title-bar menu (Bambu Studio)
- Menu entry labels still differ per slicer: Orca `Flow ratio` / `Retraction` / top-level `Max flowrate` vs Bambu `Flow rate` ▸ Coarse-Fine / `Retraction test` / `More...` ▸ `Max flowrate`
- Temp tower still steps 5 °C per block; retraction/PA towers still step once per mm of height
- Flow YOLO modifiers still ±0.05 @ 0.01; Pass 2 still −9…0%
- Bambu Studio Developer mode exposes retraction, Max flowrate, and VFA calibration while a Bambu printer is selected

## Architecture

```
src/
  types.ts               # all domain types
  app.ts / main.ts       # shell, hash router, theme, leave-guard
  styles.css             # design system (light/dark, large text, print)
  data/
    calibrations.ts      # the 7 test definitions (structured data, not pages)
    slicers.ts           # version-aware slicer instructions (Orca 2.4.x, Bambu 1.7+)
    materials.ts         # 14 material presets (suggestions only, always editable)
    glossary.ts          # searchable help content
    models.ts            # external model manifest (mirrored in public/models/)
  logic/
    formulas.ts          # formula engine — every calc returns inputs/formula/result/warnings
    ranges.ts            # suggested test ranges from material+printer+extruder
    validation.ts        # numeric/range/printer-limit validation
    confidence.ts        # confidence score
    recommendations.ts   # smart retest recommendations
  storage/               # IndexedDB wrapper + repository, drafts, settings
  export/backup.ts       # JSON export/import with schema versioning & migration
  ui/                    # dashboard, printers, project views, wizard, forms, report, card…
tests/                   # vitest suites (111 tests)
docs/                    # research notes + manual test checklist
```

Adding a calibration test = new entry in `data/calibrations.ts` + a form controller in
`ui/testForms.ts` + slicer steps in `data/slicers.ts`. No page redesign needed.

## Known limitations

- The QR code on the calibration card links to the app URL + project id — it opens the saved
  calibration on any device pointed at the **same hosted instance & browser profile**; it does
  not embed the data itself (the printed card carries the values in plain text).
- **Direct slicer profile installation is experimental and Windows-verified only.**
  PerfectFit can generate, diff, validate, and export calibrated filament presets for the
  Orca-family slicers (Orca Slicer, Bambu Studio, Snapmaker Orca, ElegooSlicer, Flash Studio /
  Orca-Flashforge) behind an experimental feature flag. Exporting a preset file works on any
  platform, including the browser build. Writing the preset directly into a slicer's profile
  folder is currently verified on Windows only, per slicer version — export remains the safe
  fallback everywhere else.
- Photos are stored and exported but not analyzed (AI photo evaluation is a designed-for,
  not-built v1 exclusion, like accounts, cloud sync, and printer control).
- Bambu Studio Developer mode exposes retraction, Max flowrate, and VFA calibration while a Bambu printer is selected; external models remain fallback options
  rather than pretending.
- Orca's built-in calibration tests always target filament slot 1 and expose no extruder picker,
  so multi-tool printers need a manual filament reassignment — the wizard says so rather than
  pretending the limitation isn't there.
- Suggested ranges are conservative starting points, not guarantees — spool labels and
  datasheets always win.

### Troubleshooting

- **Linux: blank window on launch (Wayland).** If the app opens to an empty window and, when
  launched from a terminal, prints `Could not create default EGL display: EGL_BAD_PARAMETER`,
  start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1` set — for example
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./PerfectFit_1.3.1_amd64.appimage`. WebKitGTK's DMABUF
  renderer fails to initialise EGL on some Wayland setups; this makes it fall back to a working
  path. Fixed automatically in 1.3.1 and later.

<img width="1103" height="833" alt="Auto Results" src="https://github.com/user-attachments/assets/fa9ebd12-6d73-42b2-8d50-2e8a2825b278" />

## Looking Ahead (Planned for the Next Feature Release)

Version 1.4.0 is already in active development and aims to significantly streamline the calibration workflow. The goal is a guided, session-based experience that automatically prepares each calibration test, carries results forward between steps, and reduces manual setup so you can focus on printing instead of configuring. Stay tuned over the coming weeks as this next major update takes shape.

## Future ideas

AI-assisted photo evaluation (storage schema already reserves an `analysis` field), photo
comparison, multiple nozzles/printers per filament, printer API integration, community preset
sharing, filament inventory with drying/spool tracking.

## License

Copyright (C) 2026 Aaron Taylor

PerfectFit is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** as published by the Free Software Foundation.
The full text is in [License](License).

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY —
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU Affero General Public License for more details.

**Why AGPL-3.0:** PerfectFit is built around the Orca-family slicers, and OrcaSlicer, PrusaSlicer,
and Slic3r are all AGPL-3.0. Matching that license keeps the project compatible with the ecosystem
it depends on — particularly as future releases integrate more deeply with the slicers themselves —
and guarantees the work stays open: anyone may use, modify, sell, or host PerfectFit, but
derivative works must remain open source under the same terms, including when offered over a
network.

Prior to version 1.3.1 the project used a custom non-commercial license (R3D-NC v1.0). That license
was incompatible with AGPL-3.0 code and has been retired. Releases up to and including 1.3.0 remain
available under their original terms.
