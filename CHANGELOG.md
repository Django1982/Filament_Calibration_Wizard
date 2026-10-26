# Changelog

## 1.4.0 - 2026-10-26

First release under new maintainership. Full notes: `docs/RELEASE_NOTES_1.4.0.md`.

### Added

- **Optional self-hosted persistence server** (`server/`, Docker): SQLite storage for projects, printers, photos and settings, opt-in bearer-token auth via `PERFECTFIT_API_TOKEN`, a server connection card in Settings, link-based token/server onboarding, and remote-server support in the desktop app. The browser-only default is unchanged.
- **Linux detection and launch** of Orca Slicer and Bambu Studio in the desktop app.
- **Experimental automated calibration** (off by default, Windows only): a managed, pinned OrcaSlicer prepares and slices each calibration test headlessly, behind the `automatedCalibration` flag. It never starts a print.
- Warning before leaving the slicer profile wizard mid-flow; slicer verification status now reflects the platform in use.

### Security

- `?server=` links need explicit confirmation for any host other than the page's own origin; non-http(s) values are rejected.
- Strict CSP for the desktop webview; the server sends CSP, `nosniff` and `Referrer-Policy` headers on app files.
- The OrcaSlicer executable's SHA-256 is re-verified against the vetted manifest before a slice or "open in slicer".
- Server: stored content-type injection on photo upload closed, request body size capped, malformed percent-encoding returns 400.
- CI on every push and pull request, Dependabot version updates and CodeQL enabled.

### Changed

- Upgraded TypeScript 7, Vite 8, Vitest 5, Tauri 2.12, sha2 0.11 and current minor/patch dependencies.

## 1.3.2 - 2026-07-24

Follow-up to 1.3.1, which was tagged but superseded before publication — **1.3.2 contains everything in 1.3.1 plus the items below**, so upgrading from 1.3.0 gets the lot.

Where 1.3.1 fixed the corrupted printer database, this release makes sure the correction actually reaches printers you already saved, and makes the same class of bug impossible to ship silently again.

### Added

- **Saved printers can now be refreshed when the database is corrected.** Specs are copied into a printer profile when you add it, so fixing `printers.json` did nothing for printers already on your machine — 1.3.1 could only ask people to redo them by hand. The database now carries a `dataRevision`, profiles record the revision they were filled from, and the Printers page shows a **"↻ Updated specs available"** callout on any profile that is behind. Reviewing it lists every change as `Max nozzle temp: 27 °C → 300 °C` before anything is written.

  Refreshing **keeps the profile id**, so projects referencing that printer stay linked, and preserves your printer name, notes, and retraction range. This is deliberately a review step, not a silent migration: the app does not track which fields you hand-tuned for modified hardware, so it shows the diff and asks rather than overwriting your values. Profiles saved before this release carry no revision and are treated as revision 1 — which is exactly the corrupted 1.3.0 data, so they are all offered the fix. Imported backups from 1.3.0 get the same treatment.
- **The generator rejects physically impossible values.** `npm run validate:printers` only ever checked that `printers.json` matched the workbook — and it faithfully did, which is why 250 printers with a 27 °C maximum nozzle temperature sailed through. Numeric specs are now range-checked at generation time (nozzle 150–600 °C, bed 0–200 °C, flow 0.5–200 mm³/s, and so on); anything outside its range is stored as "not specified" and reported with the row number. Zero is still preserved where it is meaningful, such as an unheated bed or chamber. It flagged 23 real data problems in the workbook on first run — 22 placeholder zeros in "Max Print Speed", plus a printer listed at 300 mm³/s of volumetric flow, roughly ten times any real hotend and almost certainly a print speed in the wrong column. All 23 have been corrected in this release (printer database `dataRevision` 3), so the generator now runs clean.

### Fixed

- **AMS and MMU printers get the filament-slot warning too.** The multi-filament warning was initially gated on `extruderCount > 1`, which missed every single-extruder machine with multiple filament slots — 12 printers in the database, including the X1 Carbon, P1S, A1, and MK4S. They have exactly the same problem: Orca assigns the calibration plate to filament slot 1 whether that slot is a separate toolhead or an AMS bay. The check now also fires on recorded AMS/MMU compatibility, with wording covering both cases. Ordinary single-filament printers show nothing.
- **Multi-line confirmation dialogs render as lines again.** Dialog text collapsed newlines into a run-on paragraph, which made the spec-refresh diff unreadable at eleven changes. Dialog bodies now honour line breaks.

## 1.3.1 - 2026-07-23 (superseded by 1.3.2, not published)

A correctness patch. Thanks to **Guntram** on the community Discord, who ran the whole procedure against OrcaSlicer 2.4.2 and reported, in detail, four places where our slicer instructions did not match what is actually on screen — plus a dialog and a multi-tool problem neither of us understood at the time. Every menu path in the app has since been re-verified against each slicer's own menu-construction source and cross-checked against installed binaries.

### Fixed

- **Printer database was silently corrupted for 374 of 379 printers — spreadsheet parser bug.** Excel writes an empty cell as a self-closing `<c r="E2" s="2"/>`. The worksheet parser matched `<c\b([^>]*)>…</c>` before the self-closing form, and `[^>]*` consumed the trailing `/` — so every blank cell was read as an opening tag whose body ran on to the *next* cell's `</c>`, stealing that cell's value. Worse, because the borrowed attributes carry no `t="s"`, shared-string **indices** were stored as if they were numbers. The visible symptom: 250 printers had a max nozzle temperature of 27 °C or 69 °C — physically impossible values that were really shared-string indices. Those two values then **clamped the suggested temperature-tower range to 27 °C and raised a blocking error on every realistic printing temperature**, making the first calibration step unusable for two-thirds of the database. Fixed by matching `/>` before `>` in a single alternation. The regenerated database corrects `maxNozzleTempC` on 250 printers (0 impossible values remain), `multiMaterialCompatibility` on 362, `heatedChamber` on 360, `profileSource` on 337, `maxChamberTempC` on 111, `maxVolumetricFlowMm3s` and `defaultNozzleDiameterMm` on 55 each, `releaseYear` on 34, and `buildVolumeMm` on 11. Blank cells now correctly read as "not specified" and fall back to the app's sensible defaults instead of nonsense. Introduced in 1.3.0 with the printer database; a regression test now pins cell-level parsing.

  **Refreshing a printer you already saved:** specs are copied into the profile when the printer is added, so updating the app does not repair an existing one. Open **Printers → Edit**, re-select your model from the dropdown, and Save — this repopulates every spec from the corrected database while keeping the same profile, so projects stay linked. Do **not** delete and re-add: re-adding mints a new profile id, and projects referencing the old one lose their printer limits, range suggestions, and safety caps. (Projects and calibration results live separately and are never deleted along with a printer, but the link is not restored by re-adding.)
- **Orca Slicer menu paths corrected — we were showing Bambu Studio's labels.** The two slicers name the same tests differently, and several of our Orca paths had drifted onto Bambu's wording. Orca 2.4.x is `Calibration → Flow ratio` (Orca names the entry after the setting; "Flow rate" is Bambu's name for it), `Calibration → Retraction` (Orca dropped the "test" suffix — the string no longer exists anywhere in the app), and `Calibration → Max flowrate` at the **top level** of the menu, second entry, with no `More…` submenu involved. Reported by **Guntram**.
- **Bambu Studio menu paths corrected in the other direction.** Max flowrate is not top-level in Bambu Studio — it lives under `Calibration → More... → Max flowrate` alongside VFA, which is the one place the two slicers genuinely differ in structure rather than just wording. The flow submenu entries are plainly `Coarse` and `Fine`. Also fixed the pressure advance path, which pointed at a `Flow Dynamics` menu entry that does not exist: the Develop-mode menu calls its manual test `Pressure advance`, while the machine's automatic Flow Dynamics wizard lives on the separate **Calibration tab**. Two different surfaces, now described as such.
- **Temperature values are now handed over in the order the slicer asks for them.** Both Orca and Bambu Studio list "First layer" *above* "Other layers" in the Filament tab's Nozzle line, but the wizard listed the other-layers value first everywhere — the results step, the generated-profile review, the report, and the summary card. Entering values out of screen order is an easy way to type one into the other's box. Reported by **Guntram**.
- **Blank window on Linux/Wayland (AppImage).** On some Wayland setups the app opened to an empty window, with `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...` printed when launched from a terminal. WebKitGTK 2.42+ defaults to a DMABUF accelerated renderer whose EGL initialisation fails on those systems; the bundled AppImage is especially affected because it ships its own `libwayland-client` that can conflict with the host compositor. The app now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before the webview starts so WebKitGTK skips the failing path (only when you haven't set the variable yourself, so an explicit override still wins). Thanks to **RThomasHyde** for the report and for pinpointing the `libwayland-client` conflict. ([#17](https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/issues/17))

### Added

- **"Resonance avoidance" dialog explained.** Orca deliberately turns Resonance avoidance off at the start of every calibration test, because it slows outer walls and would distort the result. That produces a "Creating a new project: unsaved changes" dialog — but only for people whose printer preset has the setting enabled, and of Orca's entire stock profile catalog exactly one does: `Snapmaker U1 (0.4 nozzle)`. The Orca gotchas now explain what the dialog is and that Transfer vs Discard makes no difference, since Orca creates the project first and forces the setting off immediately afterwards either way. Both paths were tested to confirm. Raised by **Guntram**, who had no way to know this was Orca's own doing.
- **Multi-tool printers get an explicit warning about filament slot assignment.** Orca's built-in tests always place the generated plate on filament slot 1 and none of the calibration dialogs expose an extruder picker, so on a 4-tool machine the test silently runs with the wrong filament — as **Guntram** found on a Snapmaker U1, having to reassign every object by hand. Printers recorded with more than one extruder now show a callout on the slicer-instructions step explaining the limitation and both workarounds. There is no way to mark a filament as "the current one" for calibration; the wizard now says so instead of leaving people to discover it.
- **New prerequisite: the selected printer preset must match the nozzle actually installed.** Slicers list every nozzle size of a machine as its own separate preset, and picking the wrong one is silent — but the built-in tests scale the model by `nozzle_diameter ÷ 0.4` and set layer height to `nozzle_diameter ÷ 2`, so a 0.6 preset on a physical 0.4 nozzle prints an oversized tower at an unachievable layer height and every result from it is misleading. Added to the temperature step, where the first test starts.

### Changed

- **License changed to GNU AGPL-3.0.** PerfectFit previously used a custom non-commercial license (R3D-NC v1.0). OrcaSlicer, PrusaSlicer, and Slic3r are all AGPL-3.0, and a non-commercial restriction cannot legally be added to a work combining AGPL code — so the old license would have blocked any deeper slicer integration. AGPL-3.0 keeps the project compatible with the ecosystem it is built on and guarantees it stays open: anyone may use, modify, sell, or host PerfectFit, but derivative works must remain open source under the same terms, including when offered over a network. Copyright is held by Aaron Taylor. Releases up to and including 1.3.0 remain available under their original terms.
- **Slicer menu documentation rewritten around the differences.** `docs/RESEARCH.md` now carries a side-by-side table of the labels each slicer uses, the full menu order for both, and the Orca calibration behaviours discovered while verifying this release (forced resonance-avoidance, slot-1 targeting, nozzle-diameter scaling, and the fact that system presets save to a "- Copy" rather than being overwritten).
- **Regression tests pin the exact menu strings per slicer**, so an Orca path can no longer silently acquire Bambu's wording (or vice versa) — that class of drift now fails CI instead of reaching a user.

## 1.3.0 - 2026-07-21

Adds a printer specification database so setting up a printer no longer means looking up every temperature limit and machine spec by hand.

### Added

- **Printer specification database (379 models, 64 manufacturers).** When you add a printer, a searchable, manufacturer-grouped combobox lets you pick your exact machine and auto-fills the known specs: manufacturer, extruder type, max nozzle/bed/chamber temperature, heated-chamber status, max volumetric flow, default and supported nozzle diameters, build volume, max print speed/acceleration, firmware, number of extruders, and multi-material (AMS/MMU) compatibility. Every value stays editable afterwards for modified or custom hardware, and saved printers show a "✓ Specs from printer database" badge.
- **Advanced machine specs section** on the printer form (chamber, build volume, supported nozzle sizes, speed/acceleration, firmware, MMU) with progressive disclosure so the common fields stay front-and-centre.
- **Chamber-aware guidance.** New-project material warnings now flag enclosure-loving materials (ABS/ASA/PA/PC…) on a printer the database says has no heated chamber, alongside the existing max-temperature and max-flow guardrails. Selected nozzle sizes are sanity-checked against the printer's supported set.
- **Maintainable data pipeline.** The database is edited in `Printer_Database/Printer_Database.xlsx`, regenerated with `npm run generate:printers` (a dependency-free Node script that reads the `.xlsx` directly — no Excel needed), validated with `npm run validate:printers`, and committed as `src/data/printers.json`. Documented under "Updating the Printer Database" in the README.
- **Bambu Studio pressure advance: opt-in "bake into start G-code (M900)".** Verified on real hardware that Bambu Studio ignores a filament preset's `pressure_advance` field for Bambu machines (the printer's Flow Dynamics owns PA — the value never reaches the sliced G-code), whereas Orca-family slicers emit the command from the field for every printer. When generating a **Bambu Studio** profile with a calibrated pressure advance, a new opt-in checkbox writes the value into the filament start G-code as `M900 K<v> L1000 M10` (the exact command Orca emits for Bambu printers) so it actually reaches the machine. Off by default; Orca-family targets never see it (they'd double-apply). Requires setting **Flow Dynamics Calibration → Off** in the Send-print-job dialog, which the toggle's help spells out.

### Fixed

- **External links now open in the desktop app.** `target="_blank"` links (shrinkage test models, documentation, model downloads) did nothing when clicked inside the Tauri window — no opener was wired up. A native `open_external_url` command now routes external http(s) links to the OS default browser. The browser build is unaffected.

### Changed

- **Slicer preset backup timestamps display in local time.** Settings → Slicer profile backups previously showed the backup time in UTC; it now shows your PC's local time (the backend still records UTC internally).
- **Pressure advance guidance corrected for Bambu.** The step notes now state accurately that Bambu Studio ignores the filament PA field for Bambu machines (Flow Dynamics owns it) and explain the M900-in-start-G-code path, while Orca-family slicers honor the native field directly.
- Printer profiles gained optional extended-spec and database-link fields (schema v4). The change is additive — existing saved printers keep working, pre-v4 printers are treated as manually configured, and older backups migrate on import. Manual entry ("My printer is not listed") is unchanged.

## 1.2.0 - 2026-07-21

Backups now happen where the risk actually starts. Until now the only automatic backup was made at the very end of the flow, when a generated profile was installed — but the wizard directs you to hand-edit your filament and printer profiles from the first calibration step onward, and none of those files were protected. Thanks to **confuzled** on the community Discord for raising this: profile backups should be offered up front — "the very first step upon installation should be prompting the user to back up (manually or automatically) their current profiles."

### Added

- **Whole-library preset snapshots.** A new native command backs up every user preset (`filament/`, `machine/`, and `process/` folders of each slicer account) into the existing checksummed backup store — same manifest format, so the Settings list, verified restore, and delete all work unchanged. Slicer-managed `base/` caches and non-preset files are excluded.
- **Pre-calibration backup prompt on every project.** Projects with remaining calibration steps show a callout offering a one-click snapshot of the project's slicer presets (falling back to all detected slicers) before any profile edits are suggested. The outcome — backed up or skipped — is recorded on the project and in its timeline. The browser build, which cannot write backups, shows manual backup guidance instead.
- **First-run backup prompt.** On first use of the desktop app (once a slicer with user presets is detected), the dashboard offers to back up all detected slicers' preset libraries. Shown once; dismissible.
- **Manual snapshots in Settings.** "Back up all slicer presets now" in Settings → Slicer profile backups snapshots every detected slicer on demand.
- **New calibration step: Flow Ratio Re-check (after Pressure Advance).** Suggested by **confuzled**: PA changes how plastic is distributed through speed transitions, so a flow ratio judged before PA can be a fine step off. The new step re-runs the fine flow plate with PA active — the 0% block winning confirms the saved value; a neighbor winning catches the error cheaply. Sits between Pressure Advance and Retraction in the default order.
- **New calibration step: Shrinkage / Dimensional Accuracy.** Also suggested by **confuzled**. Three methods, with links in the wizard: ap.engineering's free calibration plate on Printables (squares/diamonds at known 150–25 mm sizes; enter the author's spreadsheet scale-error result — the wizard converts it via shrinkage% = 100 + error — or two caliper measurements directly), Vector3D's paid CaliFlower MK2 (enter its calculator's percentages), or any large measured object (the app computes measured ÷ nominal × 100 and averages X/Y, warning when the axes disagree enough to indicate a printer mechanical issue). The result lands in the filament profile's Shrinkage field, appears on reports/cards, and — new mapping — is patched into generated profiles as `filament_shrink` ("99.4%"-style percent string).
- Projects created before this release gain both new steps automatically as not-started, inserted at their canonical position (existing progress, scores, and any custom step order are preserved).

### Changed

- **Drying advice no longer treats "fresh from a sealed bag" as dry** (thanks again, **confuzled**). PETG, TPU, PCTG and other hygroscopic materials often arrive wet from the factory even in sealed bags with desiccant. The pre-flight checklist now says dried-by-you is the requirement, and the PETG/PCTG/TPU material warnings call out factory-wet spools with drying temperatures.
- **Bambu Studio Developer-mode instructions now describe the real UI.** The Preferences checkbox is literally labeled "Develop Mode" (a translation quirk the instructions now call out), and enabling it adds a **Calibration button to the title bar next to the Redo arrow** — the same menu Orca-based slicers have — rather than a "Calibration tab". Every Bambu test's menu path was corrected accordingly.
- **Each test now names the profile you're supposed to modify.** The New Project form's "Starting filament profile" field suggests the presets actually detected in your slicer (desktop app), **ranked for the filament and printer you selected** — the brand-matching preset (or Generic when your brand isn't stocked) for your material and printer comes first, with everything else after for advanced users, and the ranking updates live as you change brand, material, or printer. Both the slicer-instructions step and the "Save it in the slicer" panel display that profile so values land in the right preset instead of whichever one happens to be selected.
- Settings: the app-data backup card is now titled "App data backup (projects & printers)" and both backup cards cross-reference each other, so PerfectFit's own data export is no longer confusable with slicer preset backups.
- The final verification checklist gained a "Dimensional accuracy" category whose ranked causes point at shrinkage and fine flow.

## 1.1.5 - 2026-07-20

Fixes generated Bambu profiles still not appearing in the slicer when cloned from a stock (system) preset — the normal path since 1.1.4 started recommending stock baselines. Diagnosed against a real signed-in Bambu Studio 2.7.x install (H2S). See [docs/RELEASE_NOTES_1.1.5.md](docs/RELEASE_NOTES_1.1.5.md).

### Fixed

- **Profiles cloned from stock presets now match what Bambu Studio itself writes, so it actually shows them.** Diagnosed by field-presence survey across all 70+ presets Bambu Studio 2.7.x had written into the real account folder vs the two invisible PerfectFit ones:
  - Clones carried stock-preset plumbing no Bambu-written user preset has: `type`, `instantiation`, and `include` — and `include` references template files that don't resolve from user folders. All three are now stripped (their contents flow through `inherits` instead).
  - Every visible preset declares `filament_extruder_variant` (the legend mapping per-slot values to hardware — e.g. `["Direct Drive Standard","Direct Drive High Flow"]` on an H2S); clones had none. Now added, sized to the preset's slots.
  - Every visible preset carries a `version` — the vendor library version from `system/BBL.json` (zero-stripped, e.g. `02.07.00.08` → `2.7.0.8`), which **no preset inside the library declares**. The native scan now reads vendor manifests and clones are stamped with it.
  - Clones kept the stock leaf's own `inherits` (an abstract `@base` preset Bambu never exposes). Bambu saves user presets inheriting the **concrete** system preset by name; clones now do the same.
  - The fresh `filament_id` introduced in 1.1.3 was only assigned when the base already declared one — stock leaves inherit theirs, so clones of stock presets had none. Now always assigned (validation blocks a missing or colliding id).
  - The `.info` sidecar always shipped an empty `user_id`; presets in an account folder carry the account id. The installer now stamps the target account's id at install time.

### Changed

- **The "Multi-tool profile" step no longer claims single-nozzle printers have two nozzles.** Bambu filament presets index per-slot arrays by (tool × hotend variant): on an H2S/P1S the two slots are the **Standard vs High Flow hotends**, not two nozzles. The wizard now explains both meanings and labels the slots accordingly, so calibration lands in the slot matching your actual hotend.

## 1.1.4 - 2026-07-20

Fixes the stock-baseline suggestions that 1.1.3 promised but did not reliably deliver, plus discoverability fixes prompted by [#10](https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/issues/10): the 1.1.3 notes told users to "re-run Create Slicer Profile", but the feature went by three different names in the app and had no entry point on the dashboard, so it couldn't be found by that name. See [docs/RELEASE_NOTES_1.1.4.md](docs/RELEASE_NOTES_1.1.4.md).

### Fixed

- **Fixed the app hanging on "Loading PerfectFit…" after updating.** The PWA service worker (registered inside the Tauri webview, where it serves no purpose) cached `index.html` cache-first; after an update it kept serving the old version's HTML, whose hashed JS bundle no longer exists, so the app never started — and uninstall/reinstall didn't help because WebView2 profile data survives uninstall. The desktop app no longer registers a service worker and unregisters any left by older versions; on Windows the app also removes stale service-worker/HTTP-cache directories from the WebView2 profile at startup, before the webview loads (calibration data in IndexedDB/localStorage is untouched). The service worker itself (web/PWA use) is now network-first for HTML so it can never pin an old shell again.
- **Stock baselines are now found and correctly matched (verified against a real Bambu Studio 2.7.x install with an H2S).** Three related defects:
  - The native scan of system vendor libraries was not recursive, missing presets in subdirectories (e.g. `system/BBL/filament/{P1P, Polymaker, SUNLU}/` — 150 presets on the dev machine). System scans now recurse (depth-limited).
  - Printer-specific system leaves (e.g. `Bambu ABS @BBL H2S`) declare `compatible_printers` but inherit `filament_type`/`filament_vendor` from abstract parents, so they could not be material-matched: they scored below user presets and, worse, "qualified" for every material. The scanner now resolves inherited metadata through the system inheritance chain. The same resolution fills `compatible_printers` for user delta presets, which previously looked compatible with every printer and polluted fallback suggestions.
  - Recommendation eligibility now requires an affirmative material-family match; presets whose material remains unknown are no longer recommendable (they stay available in Advanced mode).
- **Wizard step 2 now shows a scan summary** (`Scanned N preset(s): X stock · Y user · …`) with an explicit warning when zero stock presets arrive from the scan, so this failure mode is visible instead of silently falling back to user presets.

### Changed

- **The profile feature is now called "Create Slicer Profile" everywhere.** The project-page button (previously "Create slicer profile"), the wizard page title (previously "Create and Install Filament Profile"), and the re-run button on the generated-profiles card (previously "Open profile wizard", now "Re-run Create Slicer Profile") all use the same name, matching the release notes and documentation.
- **Create Slicer Profile is now reachable from the dashboard.** Project cards show a 🧵 Create Slicer Profile button as soon as the project has at least one calibrated value — no need to open the project first.
- **Clarified the 1.1.3 "Notes for existing users"** in the changelog and release notes: the profile is regenerated in PerfectFit (project page → 🧵 Create Slicer Profile), not via Bambu Studio's "Create New" dialog, which does not know about PerfectFit calibration data.

## 1.1.3 - 2026-07-20

Patch release fixing two profile-installer bugs found while using the 1.1.0
build with Bambu Studio. See [docs/RELEASE_NOTES_1.1.3.md](docs/RELEASE_NOTES_1.1.3.md).

### Fixed

- **Installed Bambu profiles now appear in the slicer.** In 1.1.0 a profile installed for a signed-in Bambu account was written correctly but never showed up in the filament list. Cause: when signed in, Bambu Studio dedupes filament presets by `filament_id`, so a clone that kept its parent's `filament_id` was hidden behind the cloud-synced parent it was cloned from. Confirmed directly in Bambu Studio 2.7.x — a copy with a fresh `filament_id` appears immediately; the colliding one never does. Fix: generated presets now get a fresh unique `filament_id`, and the `.info` `base_id` chains to the stock/system ancestor instead of a parent user preset's cloud id.
- **Baseline suggestions are now stock profiles compatible with the selected printer.** In 1.1.0 the "select a base profile" step suggested the user's own custom presets (some flagged as incompatible with the printer). It now recommends only stock (system) profiles — brand-name or generic — for the calibrated material that are compatible with the selected printer. User and incompatible-printer presets remain available under Advanced selection.

### Notes for existing users

- Reinstall this build for the fixes to take effect (the fix applies to newly generated profiles).
- A profile installed by 1.1.0 into a signed-in Bambu account is stuck in Bambu's cloud with the colliding id; editing local files won't unhide it. Remove it in Bambu Studio: select the preset, open it for editing (the edit/pencil icon opens the Filament settings dialog), and click the small **'X' (delete) icon in the upper-right of that edit dialog** — this removes it from your cloud sync. Then regenerate the profile **in PerfectFit** (not Bambu Studio): open your calibration project from the PerfectFit dashboard and click **🧵 Create Slicer Profile** on the project page, then follow the wizard through to install/export. Your calibration data is preserved in PerfectFit, so no re-calibration is needed.

## 1.1.0 - 2026-07-19

See [docs/RELEASE_NOTES_1.1.0.md](docs/RELEASE_NOTES_1.1.0.md) for the full release notes.

### Added

- Linux desktop release packaging via `.deb` and AppImage artifacts.
- Experimental slicer profile generation and direct install workflows for supported Orca-family slicers.
- Bambu Studio Developer mode guidance for manual calibration tests with Bambu printers selected.
- Regression tests covering Bambu Developer mode instructions, coarse/fine Flow Rate wording, and VFA mention.

### Changed

- Release workflow now builds Windows, macOS, and Linux artifacts into draft GitHub releases.
- README and research notes now document Bambu Developer mode availability for Retraction, Max Flow Rate, and VFA.

### Known limitations

- Linux packages are generated, but Linux native slicer detection/install behavior is not yet verified.
- macOS native slicer detection/install behavior remains export-oriented pending real-machine verification.
