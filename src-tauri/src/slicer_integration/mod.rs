//! Slicer profile integration — native side.
//!
//! Narrowly-scoped commands for detecting supported slicers, scanning their
//! filament presets read-only, and installing generated presets with backup,
//! atomic writes, verification, and rollback. All paths are validated in
//! `security`; the frontend can never write arbitrary files.
//!
//! Verified slicer data (folder names, executables, process names) comes from
//! docs/SLICER_PROFILE_RESEARCH.md. Do not add entries without verification.

pub mod backup;
pub mod discovery;
pub mod engine;
pub mod filesystem;
pub mod flow_test;
pub mod install;
pub mod model_project;
pub mod preset_resolver;
pub mod processes;
pub mod project_assembly;
pub mod security;

/// Static, verified per-slicer detection data.
pub struct SlicerDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Folder under %APPDATA% (Windows) / ~/Library/Application Support (macOS).
    pub data_dir_name: &'static str,
    /// Executable candidates relative to the program-files root (Windows).
    pub windows_exe_candidates: &'static [&'static str],
    /// App bundle candidates under /Applications (macOS).
    pub macos_app_candidates: &'static [&'static str],
    /// Process image names for running-detection (case-insensitive).
    pub process_names: &'static [&'static str],
}

pub const SLICERS: &[SlicerDescriptor] = &[
    SlicerDescriptor {
        id: "orca",
        display_name: "Orca Slicer",
        data_dir_name: "OrcaSlicer",
        windows_exe_candidates: &["OrcaSlicer\\orca-slicer.exe"],
        macos_app_candidates: &["OrcaSlicer.app"],
        process_names: &["orca-slicer.exe", "OrcaSlicer"],
    },
    SlicerDescriptor {
        id: "bambu",
        display_name: "Bambu Studio",
        data_dir_name: "BambuStudio",
        windows_exe_candidates: &["Bambu Studio\\bambu-studio.exe"],
        macos_app_candidates: &["BambuStudio.app"],
        process_names: &["bambu-studio.exe", "BambuStudio"],
    },
    SlicerDescriptor {
        id: "snapmaker-orca",
        display_name: "Snapmaker Orca",
        data_dir_name: "Snapmaker_Orca",
        windows_exe_candidates: &["Snapmaker_Orca\\snapmaker-orca.exe"],
        macos_app_candidates: &["Snapmaker Orca.app", "Snapmaker_Orca.app"],
        process_names: &["snapmaker-orca.exe", "Snapmaker Orca"],
    },
    SlicerDescriptor {
        id: "elegoo",
        display_name: "ElegooSlicer",
        data_dir_name: "ElegooSlicer",
        windows_exe_candidates: &["ElegooSlicer\\elegoo-slicer.exe"],
        macos_app_candidates: &["ElegooSlicer.app"],
        process_names: &["elegoo-slicer.exe", "ElegooSlicer"],
    },
    SlicerDescriptor {
        id: "flash-studio",
        display_name: "Flash Studio (Orca-Flashforge)",
        data_dir_name: "Orca-Flashforge",
        windows_exe_candidates: &[
            "Flashforge\\Orca-Flashforge\\flash studio.exe",
            "Flashforge\\Orca-Flashforge\\Orca-Flashforge.exe",
        ],
        macos_app_candidates: &["Orca-Flashforge.app", "Flash Studio.app"],
        process_names: &["flash studio.exe", "Orca-Flashforge.exe", "Orca-Flashforge"],
    },
];

pub fn descriptor(slicer_id: &str) -> Result<&'static SlicerDescriptor, String> {
    SLICERS
        .iter()
        .find(|s| s.id == slicer_id)
        .ok_or_else(|| format!("Unknown slicer id: {slicer_id}"))
}

/// Format a unix timestamp (seconds) as an ISO-8601 UTC string without
/// pulling in a date crate. Standard civil-from-days algorithm.
pub fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Shared support for the supervised real-Orca probes (the `#[ignore]`d tests).
///
/// Those probes drive an actual OrcaSlicer install, so they can only run where
/// one exists. They used to hardcode `C:\Program Files\OrcaSlicer`, which meant
/// they only worked on the exact machine they were authored on. This module
/// reads the install root (and the pinned-download zip) from environment
/// variables with a sensible default, so anyone with Orca — including the
/// Stage-10 integration CI lane, which fetches the pinned build — can run
/// `cargo test -- --ignored` by pointing `PERFECTFIT_ORCA_ROOT` at their install.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    /// Root of an OrcaSlicer install for the supervised probes. Override with
    /// `PERFECTFIT_ORCA_ROOT`; defaults to the standard Windows install path.
    pub(crate) fn orca_root() -> PathBuf {
        std::env::var_os("PERFECTFIT_ORCA_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\OrcaSlicer"))
    }

    /// The Orca executable under the install root.
    pub(crate) fn orca_exe() -> PathBuf {
        orca_root().join(if cfg!(windows) {
            "orca-slicer.exe"
        } else {
            "orca-slicer"
        })
    }

    /// `<root>/resources`.
    pub(crate) fn orca_resources() -> PathBuf {
        orca_root().join("resources")
    }

    /// A file under `<root>/resources/calib/…` (e.g. `"temperature_tower/temperature_tower.stl"`).
    pub(crate) fn orca_calib(rel: &str) -> PathBuf {
        orca_resources().join("calib").join(rel)
    }

    /// A vendor's profile dir, `<root>/resources/profiles/<vendor>`.
    pub(crate) fn orca_profiles(vendor: &str) -> PathBuf {
        orca_resources().join("profiles").join(vendor)
    }

    /// The pinned managed-Orca download zip, for the staging probe. Set
    /// `PERFECTFIT_ORCA_ZIP` to the downloaded `OrcaSlicer_Windows_V2.4.2_x64_portable.zip`;
    /// unset means the probe skips (it never hardcodes a session scratchpath).
    pub(crate) fn orca_pinned_zip() -> Option<PathBuf> {
        std::env::var_os("PERFECTFIT_ORCA_ZIP").map(PathBuf::from)
    }
}
