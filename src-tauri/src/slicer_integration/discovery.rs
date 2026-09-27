//! Read-only detection of installed slicers: data directories, versions,
//! active preset folder, user-data locations, and executables.

use super::{descriptor, security, SLICERS};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct RawUserDataLocation {
    pub account_id: String,
    pub path: String,
    pub active: bool,
    pub filament_profile_count: usize,
}

#[derive(Serialize, Clone)]
pub struct RawDetectedSlicer {
    pub slicer_id: String,
    pub data_dir: Option<String>,
    pub conf_version: Option<String>,
    pub preset_folder: Option<String>,
    pub executable_path: Option<String>,
    pub user_locations: Vec<RawUserDataLocation>,
    pub notes: Vec<String>,
}

/// Parse the slicer's `.conf` (JSON followed by a `# MD5 checksum` line) and
/// extract `app.version` and `app.preset_folder`. Strictly read-only.
fn read_conf(data_dir: &Path, data_dir_name: &str) -> (Option<String>, Option<String>, Vec<String>) {
    let mut notes = Vec::new();
    let conf_path = data_dir.join(format!("{data_dir_name}.conf"));
    let raw = match std::fs::read_to_string(&conf_path) {
        Ok(r) => r,
        Err(_) => {
            notes.push(format!("Config file not readable: {}", conf_path.display()));
            return (None, None, notes);
        }
    };
    let body = raw.split("# MD5 checksum").next().unwrap_or("");
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => {
            let app = &v["app"];
            let version = app["version"].as_str().map(|s| s.to_string());
            let preset_folder = app["preset_folder"].as_str().map(|s| s.to_string());
            (version, preset_folder, notes)
        }
        Err(e) => {
            notes.push(format!("Config parse failed: {e}"));
            (None, None, notes)
        }
    }
}

fn count_filament_presets(user_dir: &Path) -> usize {
    let filament = user_dir.join("filament");
    match std::fs::read_dir(&filament) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| {
                e.path().is_file()
                    && e.file_name()
                        .to_str()
                        .map(|n| n.to_ascii_lowercase().ends_with(".json"))
                        .unwrap_or(false)
            })
            .count(),
        Err(_) => 0,
    }
}

fn find_user_locations(data_dir: &Path, preset_folder: &Option<String>) -> Vec<RawUserDataLocation> {
    let user_root = data_dir.join("user");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&user_root) else {
        return out;
    };
    let active_id = preset_folder
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        // Only preset-shaped account dirs (they contain a filament/ or machine/ dir).
        if !p.join("filament").is_dir() && !p.join("machine").is_dir() {
            continue;
        }
        out.push(RawUserDataLocation {
            active: name == active_id,
            filament_profile_count: count_filament_presets(&p),
            path: p.display().to_string(),
            account_id: name,
        });
    }
    // Active first, then by profile count.
    out.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then(b.filament_profile_count.cmp(&a.filament_profile_count))
    });
    out
}

fn find_executable(
    candidates: &[&str],
    macos_candidates: &[&str],
    linux_candidates: &[&str],
) -> Option<PathBuf> {
    find_executable_in(
        &security::program_roots(),
        candidates,
        macos_candidates,
        linux_candidates,
    )
}

/// Roots are an explicit parameter so tests exercise the real matching logic
/// against a temp directory instead of the machine's actual program roots —
/// same reason `install::install_core` takes its directories explicitly.
fn find_executable_in(
    roots: &[PathBuf],
    candidates: &[&str],
    macos_candidates: &[&str],
    linux_candidates: &[&str],
) -> Option<PathBuf> {
    // each cfg branch uses one of them
    let _ = (candidates, macos_candidates, linux_candidates);
    for root in roots {
        #[cfg(target_os = "windows")]
        for cand in candidates {
            let p = root.join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
        #[cfg(target_os = "macos")]
        for cand in macos_candidates {
            let p = root.join(cand);
            if p.exists() {
                return Some(p);
            }
        }
        // Linux candidates are plain executable files (a native binary or an
        // AppImage `AppRun`), so is_file() applies here as it does on Windows —
        // unlike macOS, where the candidate is an .app bundle directory.
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        for cand in linux_candidates {
            let p = root.join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
pub fn detect_supported_slicers() -> Result<Vec<RawDetectedSlicer>, String> {
    let data_root = security::platform_data_root()?;
    let mut result = Vec::new();
    for s in SLICERS {
        let data_dir = data_root.join(s.data_dir_name);
        let exe = find_executable(
            s.windows_exe_candidates,
            s.macos_app_candidates,
            s.linux_exe_candidates,
        );
        if !data_dir.is_dir() && exe.is_none() {
            continue; // not installed
        }
        let (version, preset_folder, notes) = if data_dir.is_dir() {
            read_conf(&data_dir, s.data_dir_name)
        } else {
            (None, None, vec!["Data directory not found; the slicer may never have been started.".into()])
        };
        let user_locations = if data_dir.is_dir() {
            find_user_locations(&data_dir, &preset_folder)
        } else {
            Vec::new()
        };
        result.push(RawDetectedSlicer {
            slicer_id: s.id.to_string(),
            data_dir: data_dir.is_dir().then(|| data_dir.display().to_string()),
            conf_version: version,
            preset_folder,
            executable_path: exe.map(|p| p.display().to_string()),
            user_locations,
            notes,
        });
    }
    Ok(result)
}

/// Resolve and validate the filament directory for a slicer + account id.
pub fn filament_dir(slicer_id: &str, account_id: &str) -> Result<PathBuf, String> {
    security::validate_component(account_id)?;
    let s = descriptor(slicer_id)?;
    let data_root = security::platform_data_root()?;
    let dir = data_root
        .join(s.data_dir_name)
        .join("user")
        .join(account_id)
        .join("filament");
    if !dir.is_dir() {
        return Err(format!("USER_DATA_NOT_FOUND: {}", dir.display()));
    }
    // Belt and braces: the resolved dir must stay inside the slicer's data dir.
    security::ensure_under(&data_root.join(s.data_dir_name), &dir)?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct PlatformInfo {
    pub platform: String,
    pub os_version: String,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    PlatformInfo {
        platform: platform.to_string(),
        os_version: std::env::consts::OS.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guard for the registry rule in `mod.rs`: only slicers whose Linux layout
    /// has actually been verified may carry Linux executable candidates.
    #[test]
    fn only_verified_slicers_have_linux_candidates() {
        for s in SLICERS {
            let expected = matches!(s.id, "orca" | "bambu");
            assert_eq!(
                !s.linux_exe_candidates.is_empty(),
                expected,
                "unexpected linux_exe_candidates state for {}",
                s.id
            );
        }
    }
}

/// Linux executable discovery. Gated as a whole so the temp-dir helper does not
/// sit unused (and warn) on Windows/macOS builds.
#[cfg(test)]
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod linux_tests {
    use super::*;

    const ORCA_LINUX: &[&str] = &["orca-slicer", "orca-slicer/AppRun"];

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "perfectfit-test-{tag}-{}-{}",
                std::process::id(),
                crate::slicer_integration::now_unix()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempRoot(dir)
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            p
        }
        fn file(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"#!/bin/sh\n").unwrap();
            p
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn linux_finds_native_binary_in_root() {
        let t = TempRoot::new("linux-native");
        let bin = t.dir("usr-bin");
        let exe = t.file("usr-bin/orca-slicer");
        assert_eq!(find_executable_in(&[bin], &[], &[], ORCA_LINUX), Some(exe));
    }

    #[test]
    fn linux_finds_appimage_apprun_below_root() {
        // Also pins the is_file() choice: `opt/orca-slicer` exists as a
        // directory here, so an `exists()` check would return the directory.
        let t = TempRoot::new("linux-apprun");
        let opt = t.dir("opt");
        let apprun = t.file("opt/orca-slicer/AppRun");
        assert_eq!(find_executable_in(&[opt], &[], &[], ORCA_LINUX), Some(apprun));
    }

    #[test]
    fn linux_prefers_the_earlier_root() {
        // program_roots() lists $PATH before the fixed fallbacks, so a native
        // install must win over an /opt AppImage integration.
        let t = TempRoot::new("linux-order");
        let path_dir = t.dir("path-dir");
        let opt = t.dir("opt");
        let native = t.file("path-dir/orca-slicer");
        t.file("opt/orca-slicer/AppRun");
        assert_eq!(
            find_executable_in(&[path_dir, opt], &[], &[], ORCA_LINUX),
            Some(native)
        );
    }

    #[test]
    fn linux_ignores_directories_and_empty_candidate_lists() {
        let t = TempRoot::new("linux-none");
        let opt = t.dir("opt");
        t.dir("opt/bambu-studio"); // a directory, not an executable
        assert_eq!(
            find_executable_in(&[opt.clone()], &[], &[], &["bambu-studio"]),
            None
        );
        // Slicers with no verified Linux layout carry an empty candidate list.
        assert_eq!(find_executable_in(&[opt], &[], &[], &[]), None);
    }
}

#[cfg(test)]
mod manual_probe {
    // One-off supervised probe (cargo test -- --ignored). Read-only.
    #[test]
    #[ignore]
    fn probe_real_detection() {
        let out = super::detect_supported_slicers().unwrap();
        for s in &out {
            println!("{} | v={:?} | exe={:?} | preset_folder={:?}", s.slicer_id, s.conf_version, s.executable_path.is_some(), s.preset_folder);
            for l in &s.user_locations {
                println!("   loc {} active={} presets={}", l.account_id, l.active, l.filament_profile_count);
            }
        }
        assert!(!out.is_empty());
    }

    #[test]
    #[ignore]
    fn probe_real_scan() {
        let files = crate::slicer_integration::filesystem::scan_slicer_profiles("elegoo".into(), "default".into()).unwrap();
        let user = files.iter().filter(|f| f.dir_kind == "user").count();
        let base = files.iter().filter(|f| f.dir_kind == "user_base").count();
        let system = files.iter().filter(|f| f.dir_kind == "system").count();
        println!("elegoo scan: user={user} base={base} system={system}");
        assert!(user > 0);
    }
}
