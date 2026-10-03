# PerfectFit 1.3.2

A correctness patch, driven almost entirely by one very thorough community report. Thanks to **Guntram** on the Discord, who ran the full procedure against OrcaSlicer 2.4.2 and documented every place our instructions did not match what is actually on screen — and to **RThomasHyde** for the Linux AppImage report.

## ⚖️ PerfectFit is now licensed under AGPL-3.0

Starting with this release, PerfectFit moves from its old custom non-commercial license (R3D-NC v1.0) to the **GNU Affero General Public License v3** — the same license as OrcaSlicer, PrusaSlicer, and Slic3r.

**For most people this is a loosening, not a restriction.** The old license banned commercial use entirely; AGPL-3.0 permits it. You may now use, modify, sell, or host PerfectFit freely. The one obligation: if you distribute a modified version — or run one as a network service — you must make your source available under the same license.

The reason is compatibility. PerfectFit is built around the Orca-family slicers, and upcoming releases will integrate with them far more directly. AGPL section 7 forbids adding restrictions like "non-commercial" to a work that combines AGPL code, so the old license was a dead end for that roadmap.

Releases up to and including 1.3.0 remain available under their original terms.

## Highlights

- **⚠️ Printer database was corrupted for 374 of 379 printers — now fixed. Please refresh your saved printers.** A bug in the spreadsheet parser meant every blank cell stole the next cell's value, and 250 printers ended up with a max nozzle temperature of 27 °C or 69 °C. Because the app clamps the suggested temperature range to that limit and rejects anything above it, the temperature calibration step was effectively unusable for two-thirds of the printer database.

  Specs are copied into your printer profile when you add it, so fixing the database alone does not repair a printer you already saved. **The app now offers to do it for you:** open **Printers** and any affected profile shows a "↻ Updated specs available" callout. Reviewing it lists every change — `Max nozzle temp: 27 °C → 300 °C` — before anything is written, and refreshing keeps your printer name, notes, retraction range, and the profile itself, so projects using that printer stay linked.

  **Don't delete and re-add the printer.** Re-adding creates a new profile, and any project that referenced the old one loses its printer limits, range suggestions, and safety caps. (Your projects and calibration results live separately and are never deleted with a printer — but the link isn't restored by re-adding.) If you hand-tuned specs for modified hardware, cancel the refresh and edit the fields directly instead.
- **The generator now rejects physically impossible values.** `validate:printers` only checked that the JSON matched the workbook — which it faithfully did, which is why a 27 °C maximum nozzle temperature sailed through. Numeric specs are now range-checked when the database is generated, and anything implausible is stored as "not specified" and reported with its row number. It flagged 23 genuine data problems on first run, including a printer listed at 300 mm³/s of volumetric flow — all corrected in this release.
- **Slicer menu paths corrected in both directions.** Orca and Bambu Studio name the same tests differently, and several paths had drifted onto the wrong slicer's wording. Orca is `Calibration → Flow ratio`, `Calibration → Retraction`, and `Calibration → Max flowrate` at the top level; Bambu Studio is `Calibration → Flow rate → Coarse/Fine`, `Retraction test`, and `More... → Max flowrate`. The Bambu pressure advance path pointed at a menu entry that does not exist and now distinguishes the manual `Pressure advance` test from the machine's automatic Flow Dynamics wizard.
- **Temperature values are handed over in the slicer's own field order** — first layer, then other layers — matching how both slicers lay out the Nozzle line.
- **The "Resonance avoidance" dialog is explained.** Orca disables the setting for every calibration test by design; only one stock profile in Orca's catalog ships it enabled, so a small number of users saw an unexplained dialog. Transfer or Discard makes no difference, and the app now says why.
- **Multi-filament printers get a warning about slot assignment.** Orca's tests always target filament slot 1 and expose no extruder or slot picker anywhere, so the test can silently run with the wrong filament. This covers both toolchangers (Snapmaker U1, Prusa XL) and AMS/MMU machines (X1 Carbon, P1S, A1, MK4S) — an AMS bay and a separate toolhead are the same thing as far as the slicer is concerned. Both workarounds are spelled out.
- **New prerequisite:** confirm the selected printer preset matches the nozzle actually installed — the tests scale the model and layer height to the preset's nozzle diameter, so the wrong variant invalidates the result silently.
- **Blank window on Linux/Wayland (AppImage) fixed** — the app now disables WebKitGTK's DMABUF renderer, whose EGL initialisation fails on some Wayland setups.

Saved projects, printers, and backups all keep working — the only change to existing data is the opt-in spec refresh described above, which you review before it applies.

*(1.3.1 was tagged but superseded before publication; 1.3.2 contains everything from it, so upgrading from 1.3.0 gets the lot.)*

## Downloads

- Windows: NSIS installer (`.exe`).
- macOS: universal Apple Silicon + Intel disk image (`.dmg`).
- Linux: Debian package (`.deb`) plus portable AppImage (`.AppImage`).
