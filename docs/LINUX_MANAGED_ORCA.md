# Managed OrcaSlicer on Linux — acquisition spec

Status: **not built.** This is a turnkey spec for adding Linux support to the
Path-B managed OrcaSlicer engine (see
[`AUTOMATED_CALIBRATION.md`](AUTOMATED_CALIBRATION.md) → *Managed Orca engine*).
It **must be implemented and verified on a real Linux machine** — the steps that
need real-Linux confirmation are called out explicitly. Everything here is
designed so that work is mechanical once a Linux box (with the target Orca) is
available.

## Why Linux is different

The whole managed engine is built around one structural invariant: an Orca
executable is trusted only when `resources/calib` and `resources/profiles` sit
**beside** it (`validate_orca_capabilities` in
[`engine.rs`](../src-tauri/src/slicer_integration/engine.rs)). The Windows
portable zip satisfies this directly — it extracts flat to
`orca-slicer.exe` + `resources/…`.

Linux upstream ships **no portable archive** — only an **AppImage**
(`OrcaSlicer_Linux_AppImage_Ubuntu2404_V<version>.AppImage`, ~137 MB for 2.4.2)
plus Flatpaks. An AppImage is a self-mounting SquashFS: `resources/` live
*inside* the image, not next to the file on disk, so the structural validation
cannot see them on the bare `.AppImage`. That is the entire problem to solve.

## Chosen approach: `--appimage-extract`

Prefer **extraction** over running the AppImage in place:

- `./Orca….AppImage --appimage-extract` unpacks a `squashfs-root/` directory
  with the executable and its `resources/` **side by side** — turning the Linux
  case back into the same "exe + resources beside it" shape the existing
  detection already handles. No new validation path, no per-engine special
  casing in the slice runner.
- Extraction uses the AppImage runtime's built-in flag and does **not** require
  FUSE to be installed on the host (running the AppImage in place does). This
  matters on headless CI and minimal desktops.

The rejected alternative — special-casing validation to peek inside the mounted
SquashFS and running the `.AppImage` directly — couples the managed engine to
AppImage internals and needs FUSE at runtime. Only fall back to it if extraction
proves unworkable on the target distros.

## Implementation checklist

1. **Confirm the extracted layout on a real Linux box** *(needs Linux).* Run
   `./OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage --appimage-extract`
   and record the actual paths of (a) the slicer executable and (b) the
   `resources/calib` + `resources/profiles` dirs inside `squashfs-root/`. Orca's
   AppRun may place them at the root, under `usr/bin` + `usr/share`, or similar —
   this determines what `find_managed_orca_in` must look for on Linux.

2. **Pin the Linux asset** in `PINNED_MANAGED_ORCA`
   ([`engine.rs`](../src-tauri/src/slicer_integration/engine.rs)). Add a
   `#[cfg(target_os = "linux")]` arm alongside the Windows one:
   - `version` = the same version the pipeline is verified against.
   - `url` = the AppImage release download URL.
   - `sha256` + `size` = **computed from the real downloaded asset**
     (`sha256sum`, `stat -c %s`). Do not guess these; the download path refuses
     on any mismatch, by design.

3. **Teach acquisition to extract, not just unzip.** `download_managed_orca`
   currently streams a zip and calls `stage_zip_into`. For Linux, after the
   verified download: `chmod +x` the AppImage, run `--appimage-extract` into the
   managed root (or extract then move `squashfs-root/` into place), and ensure
   the resulting executable is the one `find_managed_orca` resolves. Keep the
   checksum/size verification on the **downloaded AppImage** (before extraction)
   unchanged — that is the integrity gate.

4. **Point `find_managed_orca` / detection at the extracted exe** using the
   layout confirmed in step 1. `validate_orca_capabilities` should then pass
   unchanged (resources are now beside the exe). Reuse the existing tamper-evident
   manifest + sha256-of-exe machinery as-is.

5. **UX gate follow-up.** With a second platform pinned, replace the current
   always-shown Path-B *"Install OrcaSlicer for PerfectFit"* offer with one gated
   on a native availability signal derived from `PINNED_MANAGED_ORCA` (a small
   read-only command or a field on the managed detection), so the offer appears
   exactly where a managed build can install. Keep it a single source of truth —
   do **not** duplicate the platform list in the frontend. See the follow-up note
   in `AUTOMATED_CALIBRATION.md` → *Platform scope*.

## Verification (all on real Linux)

- `cargo test --lib` green on Linux (unit lane is platform-neutral; confirm no
  Windows-only assumptions leaked in).
- With Orca extracted, run the portable probes against it:
  `PERFECTFIT_ORCA_ROOT=<squashfs-root layout> cargo test --lib -- --ignored preset_resolver:: flow_test:: model_project:: project_assembly::`
  — a real headless slice must produce non-empty g-code, exit 0, exactly as on
  Windows. (`orca_exe()` in `test_support` already picks `orca-slicer` without
  `.exe` off-Windows; adjust if the extracted binary name differs.)
- A real end-to-end `download_managed_orca` on Linux: verified download →
  extract → detect → slice.
- Extend the integration CI lane
  ([`.github/workflows/integration.yml`](../.github/workflows/integration.yml))
  with a Linux runner job once the above passes by hand.

## Notes

- **macOS** is de-prioritized. Its managed build is a `.app` bundle (resources
  inside `Contents/`); a similar "point detection at the right subdir" approach
  would apply, but it is out of scope until Linux lands and is validated.
- Nothing here changes the licensing posture: the AppImage is the *same*
  AGPL-3.0 OrcaSlicer, downloaded on demand, never committed or bundled. The
  corresponding-source pointer in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)
  must gain the Linux build's version/URL when it is pinned.
