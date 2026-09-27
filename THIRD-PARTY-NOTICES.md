# Third-Party Notices

PerfectFit — Filament Calibration Wizard is licensed under **AGPL-3.0-only**
(see [`LICENSE`](LICENSE)). This document lists third-party software that
PerfectFit uses or distributes, and their licenses.

> **⚠ Draft — must be reviewed by the project owner before any public
> distribution.** This is an engineering-prepared notice, not verified legal
> advice. The AGPL obligations below (especially providing *corresponding
> source* for the exact managed OrcaSlicer build that PerfectFit downloads)
> should be confirmed with the owner and, if needed, counsel before release.

## OrcaSlicer (optional managed slicing engine)

The **automated calibration pipeline** can drive OrcaSlicer to slice calibration
tests on the user's behalf. There are two ways this happens:

1. **The user's own OrcaSlicer install** — PerfectFit detects and runs an
   OrcaSlicer the user already installed. PerfectFit neither ships nor downloads
   anything in this case.
2. **The PerfectFit-managed OrcaSlicer (opt-in, download-on-demand)** — if the
   user has no compatible OrcaSlicer and opts in, PerfectFit downloads a
   **pinned** OrcaSlicer build from the official OrcaSlicer release and runs it
   privately for PerfectFit. PerfectFit does **not** bundle OrcaSlicer in its
   own installer or repository.

In both cases OrcaSlicer runs as a **separate program**, invoked over its
command-line interface as an external process. PerfectFit does not link against,
embed, or modify OrcaSlicer's code.

| | |
|---|---|
| **Software** | OrcaSlicer |
| **License** | GNU Affero General Public License v3.0 (**AGPL-3.0**) |
| **Upstream project** | https://github.com/OrcaSlicer/OrcaSlicer |
| **Pinned build (managed engine)** | v2.4.2 — `OrcaSlicer_Windows_V2.4.2_x64_portable.zip` |
| **Corresponding source** | https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2 (and that repository at the `v2.4.2` tag) |

**What this means for users:** the managed OrcaSlicer is free/open-source
software under the AGPL-3.0. You may obtain its complete corresponding source
code from the upstream project at the pinned tag above. Installing the managed
engine installs OrcaSlicer for PerfectFit's automation only and does not alter
any OrcaSlicer you may have installed yourself.

**In-app disclosure:** before the managed engine is downloaded, PerfectFit tells
the user that it installs OrcaSlicer, a separate open-source program (AGPL-3.0),
which PerfectFit drives automatically to slice calibration tests.

## OrcaSlicer temperature-tower model (bundled asset)

Unlike the slicer engine above, PerfectFit **does bundle one OrcaSlicer asset**:
the temperature-tower calibration model. The automated temperature calibration
must cut the exact tower window Orca's own calibration cuts (so the model's
embossed temperature labels match the printed temperatures), which requires
Orca's master model. It is shipped as
[`src-tauri/resources/temperature_tower_master.zip`](src-tauri/resources/temperature_tower_master.zip),
decoded from OrcaSlicer's `resources/calib/temperature_tower/temperature_tower.drc`
(a Draco-compressed mesh) into an uncompressed mesh at build-preparation time.

| | |
|---|---|
| **Asset** | `temperature_tower.drc` (temperature-tower calibration model) |
| **Source project** | OrcaSlicer — https://github.com/OrcaSlicer/OrcaSlicer |
| **License** | GNU Affero General Public License v3.0 (**AGPL-3.0**) — the same license as PerfectFit |
| **Corresponding source** | https://github.com/OrcaSlicer/OrcaSlicer (see `resources/calib/temperature_tower/`) |

Redistributing this asset is permitted because PerfectFit is itself AGPL-3.0; the
model is used and shipped under the same license, with attribution here. Only the
geometry is reused — the temperature schedule and cut are PerfectFit's own code.

## Notes

- OrcaSlicer itself incorporates other open-source components (e.g. it is a fork
  in the Slic3r/PrusaSlicer/BambuStudio lineage) under their respective
  licenses; those are covered by OrcaSlicer's own distribution and its bundled
  license files, not restated here.
- PerfectFit's own runtime and build dependencies are covered by their
  respective licenses as declared in `package.json` and `src-tauri/Cargo.toml`.
