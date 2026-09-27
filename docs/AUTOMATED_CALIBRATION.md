# Automated Calibration Pipeline — Architecture

> **Status: in development, disabled by default.** This document describes the
> architecture of PerfectFit's automated calibration pipeline as it is built out
> across multiple stages. The feature is gated behind the
> `automatedCalibration` experimental flag, which is **off** until the pipeline
> is complete. The existing manual calibration workflow and the slicer-profile
> installer are unaffected. **Stages 1-9 are complete for Windows** (session
> lifecycle, workflow engine, asset registry, engine layer, project generation
> for all three calibration-asset kinds, the guided UX, the finish handoff into
> the profile generator/installer, and the managed Orca engine — detection,
> download-on-demand acquisition, and the opt-in UX). **Stage 10 (hardening,
> compatibility matrix, docs, beta prep) is in progress:** the supervised
> real-Orca test probes are now environment-driven and runnable on any
> Orca-equipped machine, with an opt-in integration CI lane that fetches the
> pinned build and runs them (see [Running the real-Orca probes](#running-the-real-orca-probes)).
> Still open: Linux/macOS managed-engine acquisition (see
> [`LINUX_MANAGED_ORCA.md`](LINUX_MANAGED_ORCA.md)), owner legal review of the
> third-party notices before any public distribution, and flipping the feature
> flag on for beta.

## Goal

Let PerfectFit manage a whole calibration session: the user picks a printer,
nozzle, slicer workflow, and base filament profile, and PerfectFit prepares and
slices each calibration test itself — so the user no longer hand-drives the
slicer for every test. The user still prints, measures, and enters results, and
PerfectFit **never** starts a print on its own.

This does not replace the manual workflow; it adds an automated path alongside
it. Users without a compatible slicing engine keep the manual experience.

## Non-goals / boundaries

- Do **not** embed OrcaSlicer's UI or copy its source. Orca is driven only as an
  external executable over CLI arguments and files.
- Do **not** reverse-engineer Bambu Cloud or Bambu network protocols. Bambu
  Studio is a manual handoff destination only.
- Do **not** start a physical printer, or label an unsliced 3MF "printer-ready".
- Do **not** silently overwrite user slicer profiles or edit vendor/system
  presets.

## Core strategy: assemble a complete Orca project 3MF

A complete OrcaSlicer **project 3MF** embeds everything needed to slice with no
external preset files:

- `Metadata/project_settings.config` — a **flat, fully-resolved** settings object
  (no `inherits`).
- `Metadata/custom_gcode_per_layer.xml` — optional per-layer injected G-code used
  by parameterized tests (e.g. the pressure-advance pattern).
- `3D/3dmodel.model` — the calibration model geometry.

PerfectFit assembles such a project (calibration model + a `project_settings.config`
that merges the resolved printer/process settings with the session's calibrated
filament values + any test-specific custom G-code) and slices it via the CLI:

```
orca-slicer.exe --datadir <isolated> --outputdir <out> --slice 0 <project.3mf>
```

This mirrors what Orca's own Calibration menu produces internally, so we reuse
Orca's model instead of reverse-engineering an opaque CLI. Preset marshalling
via `--load-settings`/`--load-filaments` is **not** the primary path.

### Verified engine constraints (OrcaSlicer 2.4.2, Windows)

- **Slicing works headless.** A self-contained project 3MF slices to
  `<outputdir>/plate_1.gcode`, exit code 0, with no console.
- **CLI stdout/stderr carries little detail, and capturing it is inconsistent
  across invocation methods.** Redirecting from PowerShell reliably yields
  nothing; redirecting from bash (`orca-slicer.exe ... > out.log 2> err.log`)
  does capture *something*, but Windows builds only ever emit a generic
  `"Slic3r::CLI::run found error, exit"` line — the detailed JSON reason
  (`record_exit_reson()` in Orca's own `OrcaSlicer.cpp`) is compiled
  **Linux-only**, so the specific failure (which exit code, which check
  tripped) never reaches stdout on Windows regardless of how it's captured.
  **Success is judged from the output artifact and Orca's log at
  `<datadir>/log/`, never from stdout** — and when a real Orca exit code needs
  decoding, the authoritative source is Orca's own `src/libslic3r/Utils.hpp`
  (`#define CLI_* -N`), not anything the process prints.
- **Always use an isolated `--datadir`.** This gives readable logs and, critically,
  never touches the user's real Orca configuration (`%APPDATA%/OrcaSlicer/`).

## Key architectural interfaces

Defined in [`src/automatedCalibration/types.ts`](../src/automatedCalibration/types.ts):

- **`SlicingEngine`** — pluggable slicing backend. Planned implementations:
  `ManagedOrcaEngine`, `InstalledOrcaEngine`, `ManualExportEngine`,
  `BambuStudioHandoff`. Engines are **not** responsible for printer
  communication.
- **`PrintDestination`** — where a prepared/sliced job goes, kept separate from
  slicing. Initial: `SaveToFileDestination`, `OpenInInstalledSlicerDestination`.
  Future extension points: Moonraker, OctoPrint, PrusaLink.
- **`TemporaryCalibrationProfile`** — a working filament profile a session
  mutates as results arrive, tracking value provenance (base profile vs.
  material default vs. user input vs. calibration result). Normalized PerfectFit
  keys; slicer-specific mapping stays in `src/slicerIntegration/adapters`.
- **`CalibrationStepDefinition`** — the dependency-aware step model the workflow
  engine builds on top of the instructional content in
  `src/data/calibrations.ts`.
- **`CalibrationAssetDefinition`** — licensed, versioned, checksummed calibration
  model/registry entry (bundled, downloaded, or user-provided).

### Engine layer (Stage 5)

Two engines implement `SlicingEngine` so far:

- **`ManualExportEngine`** — always available, needs no external slicer. It
  reports export capability but **not** slice capability; `slice()` returns a
  deliberately not-sliced job (never a fake "printer-ready" one). This is the
  guaranteed fallback for browser builds and users without Orca.
- **`InstalledOrcaEngine`** — drives an OrcaSlicer install the user already has
  (auto-detected, or an executable they select manually) as an external process.

Discovery, validation, and slicing are delegated to native Tauri commands in
[`src-tauri/src/slicer_integration/engine.rs`](../src-tauri/src/slicer_integration/engine.rs):

- **Capability validation is by structure, not name.** An executable is trusted
  as a slicing engine only when it ships `resources/calib` and `resources/profiles`
  beside it — the assets the pipeline depends on — so a mis-named or unrelated
  binary is rejected rather than name-trusted.
- **A tamper-evident engine manifest** (id, executable path, version, sha256
  checksum, capabilities) is written under a PerfectFit-managed root. The slice
  runner launches only the manifest-vetted binary; the frontend never passes a
  raw executable path.
- **The process runner** captures exit code and duration, enforces a timeout,
  honors a cancellation token, and always reaps the child — but **never captures
  stdout**. Success is judged from the output artifact (present, non-empty) and
  the engine's `<datadir>/log/`.
- **Isolated per-job paths.** The frontend passes validated session/job ids, and
  the runner resolves them to `sessions/<id>/jobs/<id>/{workspace,datadir,out}`
  under the managed root — never touching the user's real Orca configuration.

`discoverEngines()` summarizes engine status (detected / valid / capabilities /
recommended engine); the Stage 7 UX (`src/ui/automatedCalibration.ts`, reachable
at `#/automated/:id`) renders it as a live status card with a re-check action.

### Project generation (Stage 6)

PerfectFit turns a shipped calibration project into one carrying the session's
calibrated values by assembling a complete project 3mf:

- **Config merge (pure TS,
  [`orcaProjectConfig.ts`](../src/automatedCalibration/orcaProjectConfig.ts)).**
  Parses the template's flat `project_settings.config`, overwrites only the
  calibrated filament keys (reusing the profile installer's verified
  calibration→Orca-key mapping and array-of-strings semantics), and serializes
  it back with the template's key order preserved. Every other setting stays
  byte-for-byte.
- **Assembly (native,
  [`project_assembly.rs`](../src-tauri/src/slicer_integration/project_assembly.rs)).**
  `read_project_config` extracts the template's config for the merge;
  `assemble_calibration_project` copies the template 3mf and swaps in the merged
  config, writing `project.3mf` into the job workspace. Only the one config
  entry changes; the model, per-layer custom g-code, and relationships are
  preserved. The source template is confined to the vetted engine's own
  `resources/` (a calibration model always comes from the user's install).
- **Verified end-to-end on real Orca (2.4.2, Windows).** An assembled, modified
  `pa_pattern` project slices headless to a 94 KB `plate_1.gcode`, exit 0.

Stage 6 covers all three calibration-asset kinds a project can ship as, each
verified with a real headless Orca slice:

- **`project-template`** (e.g. pressure-advance) — the case above: the template
  is already a complete project, so only the config entry is swapped.
- **`stl`** (the temperature tower) — a bare master STL with no config or plate
  at all. `model_project.rs` parses the binary STL, cuts it to the material's
  band count × 10 mm (Orca's own convention, reverse-engineered from real
  exported Orca artifacts), and synthesizes the missing `3D/3dmodel.model` +
  `Metadata/model_settings.config` scaffolding a project needs — a bare model
  plus a config alone does **not** slice (confirmed: Orca rejects it outright,
  no g-code produced, before this scaffolding was added). The per-band `M104`
  temperature schedule is injected as `custom_gcode_per_layer.xml`, the same
  proven injection path as pressure-advance — PerfectFit reproduces Orca's
  temperatures independently rather than depending on Orca's own (undocumented)
  temp-tower recognition.
- **`3mf`** (flow-rate: `flow-pass1`/`flow-pass2`/`flow-verify`) — Orca's
  shipped multi-object flow plates carry geometry but zero config, similar to
  the STL case but with 9-11 pre-positioned objects instead of one. The
  per-object `print_flow_ratio` override mechanism was reverse-engineered from
  OrcaSlicer's own public source (`Plater::calib_flowrate` in
  `src/slic3r/GUI/Plater.cpp`): each object's name (e.g. `flowrate_m10`)
  encodes a modifier, combined with the current flow ratio via one of two
  formulas (percent or linear/YOLO), serialized as per-object
  `model_settings.config` metadata. `flow_test.rs` reuses the template's own
  mesh byte-for-byte and only adds the missing scaffolding + per-object
  overrides. A real-Orca probe assembling `flowrate-test-pass1.3mf` with
  computed per-object ratios slices to 1.4 MB of g-code, exit 0.

**Printer preset resolution
([`preset_resolver.rs`](../src-tauri/src/slicer_integration/preset_resolver.rs)).**
An arbitrary printer's settings are resolved from Orca's own vendor profiles by
walking the `inherits` chains under `resources/profiles/<Vendor>/{machine,
process,filament}/`. Parents are vendor-local (every vendor ships its own base
presets), so resolution is a bounded single-vendor index-and-walk; each chain is
merged child-overrides-parent, and the three resolved objects combine into one
flat `project_settings.config`. Verified on the live install: resolving a Bambu
X1 Carbon selection yields that printer's config (364 keys, correct
`printer_model`/`nozzle_diameter`), and Orca slices a project built from it
(117 KB `plate_1.gcode`, exit 0 — distinct from the N1 template's output).

A PerfectFit printer selection is mapped to those exact preset names by
[`printerMapping.ts`](../src/automatedCalibration/printerMapping.ts): a
PerfectFit printer's `model` equals Orca's machine `printer_model`, so the
native `list_installed_machines` index is matched on model + nozzle to the
machine leaf, whose `default_print_profile` gives the process
(`InstalledOrcaEngine.resolveForPrinter(selection, filamentName)`). Filament is
a **separate selection**: Orca machine leaves carry no default filament, and in
a calibration the material is the thing being tuned, so the caller supplies the
filament preset (`resolveForMaterial` picks the best installed match for the
material automatically; the material→filament ranking lives in
`filamentSelection.ts`).

### Guided session UX (Stage 7)

[`src/ui/automatedCalibration.ts`](../src/ui/automatedCalibration.ts), reachable
at `#/automated/:id` and linked from the project page once the experimental
flag is on (`src/ui/settings.ts`):

- **Engine status** — a live card (`discoverEngines()`) with a re-check action.
- **Starting a session** reuses the printer/nozzle/material the project already
  has (no separate picker needed for the common case — `resolveForMaterial`
  maps it automatically); a **manual fallback picker** lists installed Orca
  machines/filaments directly (`list_installed_machines`/`list_vendor_filaments`)
  for printers not linked to PerfectFit's printer database (hand-entered
  profiles) or when the automatic mapping can't find a match. The chosen
  override (`manualOrcaPreset`) is reused for every later resolve in that
  session.
- **Per-step prepare → slice → review**, in place: each ready, slice-needing
  step gets a "Prepare & slice" action (`prepareProject` → `slice` →
  `inspectOutput`), rendering success (duration, g-code path, findings, a link
  into the *existing* manual wizard's result-entry step) or failure (exit
  code, engine log path, findings). Recording the measured result is
  deliberately **not** reimplemented — it's identical regardless of how the
  test was sliced, so a successful slice links straight to
  `#/wizard/:id/:step` instead of duplicating that UI.
- **Resume / cancel / restart** — a resumable session surfaces on the
  dashboard; cancelling (with confirmation) stops it without touching recorded
  calibration results; a cancelled/failed session offers a fresh restart with
  the same printer/material (or a re-picked manual override).

This repo's Vitest environment is `'node'`, so no `src/ui/*.ts` file has
unit-test coverage by convention — this screen is verified by real
click-through in a dev-server browser (with a faked Tauri bridge standing in
for the desktop native layer) instead.

### Finish & profile install (Stage 8)

The automated pipeline finishes by handing off to the **existing, verified**
slicer-profile generator/installer (`src/slicerIntegration/`, driven by
[`src/ui/profileWizard.ts`](../src/ui/profileWizard.ts) at `#/profile/:id`) —
it is **not** reimplemented for the automated path. This works because an
automated session *is* a `CalibrationProject` (Stage 2), and recording each
measured result writes `project.finals` — exactly the source the profile
generator already reads (`buildPatchesFromProject`). The measured results, not
any intermediate working-profile values, are what get baked into the exported
or installed filament profile.

- **From the automated screen** ([`src/ui/automatedCalibration.ts`](../src/ui/automatedCalibration.ts)):
  once at least one calibrated value is recorded, a **"Finish calibration"**
  card summarizes the recorded values and links into `#/profile/:id`. A
  completed session's card links there too, so a finished session can still
  (re)generate or re-install a profile.
- **A deliberate "Mark session complete"** action (`completeSession`, with a
  confirmation) closes the session. Completion is terminal but non-destructive:
  recorded results and any generated profile are kept, and a new session can be
  started later.
- **From the profile wizard back to the session:** after a successful install
  or export, if the project still has an open automated session, the result
  stage offers "Back to automated session" and the same "Mark session complete"
  close-out — so the loop closes from whichever screen the user finishes on.

Nothing in Stage 8 changes the installer itself; it only wraps it. The
installer's own guarantees hold unchanged — it backs up affected slicer files
first, never edits vendor/system presets, and export always works even when a
version isn't verified for direct install. Verified by real dev-server
click-through (per the `src/ui/*.ts` convention above): the finish handoff, the
`#/profile/:id` target loading, a full generate→export cycle surfacing the
close-out, and the mark-complete transition persisting `sessionStatus:
completed`.

### Managed Orca engine (Stage 9)

The automated pipeline needs a slicing engine, but not every user has OrcaSlicer
installed (many print only with Bambu Studio). So PerfectFit offers a
**managed** OrcaSlicer alongside the user's own install:

- **Path A — the user already has OrcaSlicer:** `InstalledOrcaEngine` detects
  and drives it. Nothing is downloaded.
- **Path B — no OrcaSlicer:** the user opts in and PerfectFit downloads a
  **pinned** OrcaSlicer build on demand (`ManagedOrcaEngine`).
- **Path C — the user doesn't want automation:** nothing is installed; the
  manual workflow is untouched.

The managed engine is the *same* OrcaSlicer, driven the same way — it just lives
under PerfectFit's own root (`<app-data>/perfectfit/engines/managed-orca/`)
instead of the user's Program Files. `ManagedOrcaEngine` **reuses the entire
`InstalledOrcaEngine` implementation** (detection, preset resolution, project
assembly, slicing), differing only in its engine id and where the native side
looks for the executable. Every native command already keys off the engine id
and resolves the executable/resources from that engine's tamper-evident
manifest, so the whole slice pipeline works for the managed engine unchanged.
`discoverEngines()` prefers an installed Orca, then the managed one, then the
always-available manual-export fallback.

**Download-on-demand acquisition.** The pinned build (version, URL, and
**sha256**) lives in **native code**, so the frontend can never redirect the
download. `download_managed_orca` streams the asset to a temp file while
computing its SHA-256 in one pass, refuses to install on any checksum/size
mismatch, extracts it (zip-slip-guarded) into the managed root, records the
version, and re-detects to persist the manifest. The download is cancellable.
No OrcaSlicer binary is ever committed to this repository or bundled in
PerfectFit's own installer.

**Opt-in + disclosure.** When no usable OrcaSlicer is detected, the automated
screen offers *"Install OrcaSlicer for PerfectFit"* with a plain-language
disclosure that this installs OrcaSlicer, a **separate** open-source program
(AGPL-3.0), which PerfectFit drives via automation. Licensing/attribution is in
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) — **draft, pending owner
legal review before any public distribution.**

**Platform scope.** Only the **Windows x64** build is pinned so far (the
version the whole pipeline was verified against). `PINNED_MANAGED_ORCA` is the
single source of truth — it is `None` on every other platform, so
`download_managed_orca` refuses with a clear "no managed build for this platform
yet — install OrcaSlicer manually" message rather than failing silently. On
non-Windows the managed engine therefore degrades honestly to Path A/C (use an
installed Orca, or the manual workflow). Linux is the next target (see
[`LINUX_MANAGED_ORCA.md`](LINUX_MANAGED_ORCA.md)); macOS is de-prioritized.

> **Follow-up (lands with Linux support):** today the Path-B *"Install
> OrcaSlicer for PerfectFit"* offer still renders on non-Windows and only
> reports "not available for this platform" on click. When a second platform is
> pinned, gate the offer on a native availability signal derived from
> `PINNED_MANAGED_ORCA` (not a duplicated frontend platform check) so the button
> is shown exactly where a managed build can actually install — one source of
> truth, no drift.

### Hardening & release readiness (Stage 10)

Stage 10 does not add pipeline features; it makes the Windows-complete pipeline
releasable — test visibility, cross-platform honesty, docs, and merge prep.

#### Platform & engine support matrix

Where the automated pipeline can slice today, by platform × engine source. "Path
A/B/C" are the acquisition paths from [Managed Orca engine](#managed-orca-engine-stage-9).

| Platform    | Installed Orca (Path A) | Managed Orca (Path B) | Manual export | Direct profile install |
|-------------|-------------------------|-----------------------|---------------|------------------------|
| Windows x64 | ✅ verified (2.4.2)      | ✅ verified (pinned)   | ✅ always      | ✅ verified (5 slicers) |
| Linux       | ⚠️ untested¹            | ❌ not built²          | ✅ always      | ⚠️ unconfirmed          |
| macOS       | ⚠️ untested¹            | ❌ de-prioritized      | ✅ always      | ⚠️ export-only          |

1. `InstalledOrcaEngine` is platform-neutral in principle (it drives whatever
   vetted `orca-slicer` executable the manifest records), but the slice/resolve
   pipeline has only been *proven* on Windows. The probes are now portable
   (below), so a Linux/macOS box with Orca can validate it.
2. No managed build is pinned — see [`LINUX_MANAGED_ORCA.md`](LINUX_MANAGED_ORCA.md).

#### Running the real-Orca probes

The supervised, real-Orca tests are Rust `#[ignore]`d probes (they drive an
actual OrcaSlicer install, so they can't run in the normal unit lane — GitHub's
default runners and Orca-less dev machines have no Orca). They are **environment
-driven** (`slicer_integration::test_support`), so any Orca-equipped machine can
run them — not just the box they were authored on:

- `PERFECTFIT_ORCA_ROOT` — the OrcaSlicer install root (defaults to
  `C:\Program Files\OrcaSlicer`). The probes derive the executable and
  `resources/{calib,profiles}` from it.
- `PERFECTFIT_ORCA_ZIP` — a downloaded `OrcaSlicer_Windows_V2.4.2_x64_portable.zip`
  for the download-staging probe; unset means that one probe skips cleanly.

```bash
# From src-tauri/. Runs the seven Orca-resource probes against the default install:
cargo test --lib -- --ignored --nocapture \
  engine::tests::probe_stage_real_orca_zip flow_test:: model_project:: \
  preset_resolver:: project_assembly::

# Or point at a non-default install:
PERFECTFIT_ORCA_ROOT="/opt/OrcaSlicer" cargo test --lib -- --ignored preset_resolver::
```

The installer's own probes (`discovery::…::probe_real_*`, `install::…::manual_*`)
need a slicer *installed* in the OS's normal locations (plus `MANUAL_*` paths)
and are a separate concern from automated-calibration slicing.

**Integration CI lane** ([`.github/workflows/integration.yml`](../.github/workflows/integration.yml)):
a `workflow_dispatch`-only job (never on push/PR — it downloads ~171 MB and runs
real slices) that fetches the pinned Orca build, verifies its checksum+size
against the same pin as the app, sets `PERFECTFIT_ORCA_ROOT`, and runs the seven
resource probes. This is how the `#[ignore]`d probes get exercised in CI without
breaking the fast unit lane.

### Relationship to existing code

The automated session **extends the existing `CalibrationProject`** — it is not a
parallel entity. `AutomatedSessionExtension`'s (all-optional) fields folded into
`CalibrationProject` in Stage 2 (storage schema v5, purely additive — no
`DB_VERSION`/`onupgradeneeded` change was needed since IndexedDB already stores
whatever optional fields an object carries). Session state lives in IndexedDB
like the rest of the app; only slicer working directories and sliced artifacts
live on the filesystem.

## Expected filesystem layout (engine + jobs)

The `sessions/<id>/jobs/<id>/{workspace,datadir,out}` layout below is
implemented and in active use since Stage 5 (the process runner) and Stage 6
(project assembly). `engines/managed-orca/` is populated by the Stage 9
download-on-demand acquisition when the user opts in. Everything lives under an
application-managed root, isolated per session and per job:

```
<app-data>/perfectfit/
  engines/
    managed_orca.json          # tamper-evident manifest (id, version, checksum, caps)
    managed-orca/              # extracted portable Orca (Path B, opt-in)
      orca-slicer.exe
      resources/{calib,profiles}/…
      version.txt
  sessions/
    <sessionId>/
      jobs/
        <jobId>/
          workspace/           # staged model + assembled project.3mf + manifest
          datadir/             # isolated Orca --datadir (config + log/)
          out/                 # sliced artifacts (plate_1.gcode, …)
```

No Orca executable is committed to this repository or bundled in PerfectFit's
own installer. The managed engine is downloaded on demand from the pinned
upstream release only when the user opts in — see "Managed Orca engine
(Stage 9)" above.

## Staged delivery

Built on a long-running `feature/automated-calibration` branch (never on `main`
until complete). Each stage keeps the app buildable, keeps existing tests green,
and leaves the automated behavior disabled until it is ready.

| Stage | Focus |
|-------|-------|
| 0 | Orca CLI spike (throwaway) — proved headless slicing viability |
| 1 | Repository audit + architectural contracts + disabled flag (this document) |
| 2 | Durable sessions + temporary profiles (extend `CalibrationProject`) |
| 3 | Workflow registry + result inheritance / stale-job invalidation |
| 4 | Calibration asset registry + project preparation (unsliced workspace) |
| 5 | Engine discovery/validation + safe process runner |
| 6 | Orca project generation + automated slicing (all calibration-asset kinds) |
| 7 | End-to-end guided automated session UX |
| 8 | Finish Calibration — profile export/install (wraps the verified installer) |
| 9 | Managed Orca engine + packaging + third-party notices |
| 10 | Hardening, compatibility matrix, docs, beta prep |

Stage 9 is **not optional**: at release, PerfectFit has no way to know whether a
given user has OrcaSlicer installed at all — many print with Bambu Studio (or
another slicer) exclusively and have never installed Orca. Without a managed
engine, the automated pipeline only ever benefits users who already happen to
have Orca on their machine; everyone else keeps the manual workflow with no
automation, regardless of how complete Stages 1-8 are.

## Licensing note

OrcaSlicer is AGPL-3.0; PerfectFit is AGPL-3.0-only. Driving Orca as a separate
executable keeps a bundled engine "mere aggregation" rather than a derivative
work. Distributing or downloading the Orca binary still obliges PerfectFit to
provide the pinned version's corresponding source and AGPL notices. Third-party
licensing/attribution artifacts are added in Stage 9 and **must be reviewed by
the project owner before any public distribution** — nothing here constitutes
verified legal advice.
