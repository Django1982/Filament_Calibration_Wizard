//! Timestamped, checksummed backups of slicer files before installation,
//! with verified restore. Backups live in PerfectFit's own app-data folder:
//!
//! {app_data}/slicer-backups/{slicer-id}/{backup-id}/
//!     manifest.json
//!     files/0.json, 1.info, …
//!
//! Restore only ever writes back to the exact original paths recorded in the
//! manifest, re-validated against the slicer data roots at restore time.

use super::{iso_from_unix, now_unix, security};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileEntry {
    pub original_path: String,
    pub backup_path: Option<String>,
    pub checksum_sha256: Option<String>,
    pub existed_before: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBackupManifest {
    pub backup_id: String,
    pub slicer_id: String,
    pub slicer_version: Option<String>,
    pub created_at: String,
    pub installed_profile_name: String,
    pub perfect_fit_project_id: String,
    pub files: Vec<BackupFileEntry>,
    pub backup_root: String,
}

#[derive(Serialize)]
pub struct RawBackupSummary {
    pub backup_id: String,
    pub slicer_id: String,
    pub created_at: String,
    pub installed_profile_name: String,
    pub perfectfit_project_id: String,
    pub file_count: usize,
    pub backup_root: String,
}

pub fn backups_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?
        .join("slicer-backups");
    Ok(dir)
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Read failed {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Create and verify a backup covering `paths` (files that are about to be
/// created or replaced). Files that do not exist yet are recorded with
/// `existed_before: false` so restore knows to delete them.
/// `all_backups_root` is injected so integration tests can use a temp dir.
pub fn create_backup(
    all_backups_root: &Path,
    slicer_id: &str,
    slicer_version: Option<String>,
    profile_name: &str,
    project_id: &str,
    paths: &[PathBuf],
) -> Result<ProfileBackupManifest, String> {
    let now = now_unix();
    let backup_id = format!("{now}-{}", std::process::id());
    let root = all_backups_root.join(slicer_id).join(&backup_id);
    let files_dir = root.join("files");
    std::fs::create_dir_all(&files_dir).map_err(|e| format!("Cannot create backup dir: {e}"))?;

    let mut entries = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        if p.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin")
                .to_ascii_lowercase();
            let dest = files_dir.join(format!("{i}.{ext}"));
            std::fs::copy(p, &dest).map_err(|e| format!("Backup copy failed for {}: {e}", p.display()))?;
            let src_sum = sha256_file(p)?;
            let dest_sum = sha256_file(&dest)?;
            if src_sum != dest_sum {
                return Err(format!("Backup verification failed for {}", p.display()));
            }
            entries.push(BackupFileEntry {
                original_path: p.display().to_string(),
                backup_path: Some(dest.display().to_string()),
                checksum_sha256: Some(src_sum),
                existed_before: true,
            });
        } else {
            entries.push(BackupFileEntry {
                original_path: p.display().to_string(),
                backup_path: None,
                checksum_sha256: None,
                existed_before: false,
            });
        }
    }

    let manifest = ProfileBackupManifest {
        backup_id: backup_id.clone(),
        slicer_id: slicer_id.to_string(),
        slicer_version,
        created_at: iso_from_unix(now),
        installed_profile_name: profile_name.to_string(),
        perfect_fit_project_id: project_id.to_string(),
        files: entries,
        backup_root: root.display().to_string(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Manifest serialize failed: {e}"))?;
    let manifest_path = root.join("manifest.json");
    std::fs::write(&manifest_path, &manifest_json)
        .map_err(|e| format!("Manifest write failed: {e}"))?;
    // Verify the manifest is readable back.
    let reread = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Manifest re-read failed: {e}"))?;
    serde_json::from_str::<ProfileBackupManifest>(&reread)
        .map_err(|e| format!("Manifest re-parse failed: {e}"))?;
    Ok(manifest)
}

/// Subdirectories of a user account dir that hold user-editable presets.
const PRESET_LIBRARY_DIRS: &[&str] = &["filament", "machine", "process"];

/// Largest file included in a library snapshot (a preset is a few KB).
const MAX_SNAPSHOT_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Hard cap so a misconfigured directory can never balloon a snapshot.
const MAX_SNAPSHOT_FILES: usize = 5000;

/// Collect every preset file (.json/.info) directly inside the account's
/// filament/, machine/ and process/ dirs. Non-recursive: base/ caches and
/// other subdirectories are slicer-managed, not user-edited.
pub fn user_preset_files(user_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for sub in PRESET_LIBRARY_DIRS {
        let dir = user_dir.join(sub);
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if security::validate_preset_extension(name).is_err() {
                continue;
            }
            if std::fs::metadata(&p)
                .map(|m| m.len() > MAX_SNAPSHOT_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            out.push(p);
        }
    }
    out.sort();
    out
}

/// Snapshot an entire user preset library into the regular backup system.
/// Produces the same manifest format as install backups, so listing, restore,
/// and delete work unchanged. `label` fills the manifest's profile-name slot
/// shown in the backups list.
pub fn snapshot_user_presets_core(
    all_backups_root: &Path,
    slicer_id: &str,
    label: &str,
    project_id: &str,
    user_dir: &Path,
) -> Result<ProfileBackupManifest, String> {
    let files = user_preset_files(user_dir);
    if files.is_empty() {
        return Err(format!(
            "No user preset files found under {} — nothing to back up.",
            user_dir.display()
        ));
    }
    if files.len() > MAX_SNAPSHOT_FILES {
        return Err(format!(
            "Refusing to snapshot {} files (limit {MAX_SNAPSHOT_FILES}) — this does not look like a preset library.",
            files.len()
        ));
    }
    create_backup(all_backups_root, slicer_id, None, label, project_id, &files)
}

/// Back up a slicer account's whole user preset library (filament, machine,
/// process presets) before the user starts editing profiles. Read-only with
/// respect to slicer data; writes only into PerfectFit's backup folder.
#[tauri::command]
pub fn backup_slicer_user_presets(
    app: tauri::AppHandle,
    slicer_id: String,
    account_id: String,
    project_id: String,
) -> Result<RawBackupSummary, String> {
    security::validate_component(&account_id)?;
    let slicer = super::descriptor(&slicer_id)?;
    let data_root = security::platform_data_root()?;
    let slicer_root = data_root.join(slicer.data_dir_name);
    let user_dir = slicer_root.join("user").join(&account_id);
    if !user_dir.is_dir() {
        return Err(format!("USER_DATA_NOT_FOUND: {}", user_dir.display()));
    }
    security::ensure_under(&slicer_root, &user_dir)?;
    let backups_root = backups_root(&app)?;
    let label = format!("Preset library snapshot ({account_id})");
    let m = snapshot_user_presets_core(&backups_root, &slicer_id, &label, &project_id, &user_dir)?;
    Ok(RawBackupSummary {
        backup_id: m.backup_id,
        slicer_id: m.slicer_id,
        created_at: m.created_at,
        installed_profile_name: m.installed_profile_name,
        perfectfit_project_id: m.perfect_fit_project_id,
        file_count: m.files.len(),
        backup_root: m.backup_root,
    })
}

fn load_manifest(app: &tauri::AppHandle, backup_id: &str) -> Result<ProfileBackupManifest, String> {
    security::validate_component(backup_id)?;
    let root = backups_root(app)?;
    for slicer_dir in std::fs::read_dir(&root)
        .map_err(|e| format!("No backups found: {e}"))?
        .flatten()
    {
        let candidate = slicer_dir.path().join(backup_id).join("manifest.json");
        if candidate.is_file() {
            let raw = std::fs::read_to_string(&candidate)
                .map_err(|e| format!("Manifest read failed: {e}"))?;
            return serde_json::from_str(&raw).map_err(|e| format!("Manifest parse failed: {e}"));
        }
    }
    Err(format!("Backup {backup_id} not found"))
}

/// Restore a backup: copy back every file that existed before (after checksum
/// verification of the backed-up copy) and delete files that did not exist.
/// Original paths are re-validated against `allowed_root` (the slicer's data
/// directory in production; a temp directory in integration tests).
pub fn restore_backup_inner(
    manifest: &ProfileBackupManifest,
    allowed_root: &Path,
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut restored = Vec::new();
    let mut deleted = Vec::new();
    for f in &manifest.files {
        let original = PathBuf::from(&f.original_path);
        security::ensure_target_under(allowed_root, &original)?;
        security::validate_preset_extension(
            original.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        )?;
        if f.existed_before {
            let backup_path = f
                .backup_path
                .as_ref()
                .ok_or_else(|| "Manifest entry missing backup path".to_string())?;
            let bp = PathBuf::from(backup_path);
            let sum = sha256_file(&bp)?;
            if Some(&sum) != f.checksum_sha256.as_ref() {
                return Err(format!(
                    "Backup file checksum mismatch for {} — refusing to restore corrupted data",
                    bp.display()
                ));
            }
            std::fs::copy(&bp, &original)
                .map_err(|e| format!("Restore copy failed for {}: {e}", original.display()))?;
            let restored_sum = sha256_file(&original)?;
            if restored_sum != sum {
                return Err(format!("Restore verification failed for {}", original.display()));
            }
            restored.push(f.original_path.clone());
        } else if original.is_file() {
            std::fs::remove_file(&original)
                .map_err(|e| format!("Restore delete failed for {}: {e}", original.display()))?;
            deleted.push(f.original_path.clone());
        }
    }
    Ok((restored, deleted))
}

#[derive(Serialize)]
pub struct RestoreResult {
    pub restored_files: Vec<String>,
    pub deleted_files: Vec<String>,
}

#[tauri::command]
pub fn list_profile_backups(app: tauri::AppHandle) -> Result<Vec<RawBackupSummary>, String> {
    let root = backups_root(&app)?;
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Ok(out);
    };
    for slicer_dir in rd.flatten() {
        let Ok(inner) = std::fs::read_dir(slicer_dir.path()) else {
            continue;
        };
        for b in inner.flatten() {
            let manifest_path = b.path().join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
                if let Ok(m) = serde_json::from_str::<ProfileBackupManifest>(&raw) {
                    out.push(RawBackupSummary {
                        backup_id: m.backup_id,
                        slicer_id: m.slicer_id,
                        created_at: m.created_at,
                        installed_profile_name: m.installed_profile_name,
                        perfectfit_project_id: m.perfect_fit_project_id,
                        file_count: m.files.len(),
                        backup_root: m.backup_root,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn get_profile_backup_manifest(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<ProfileBackupManifest, String> {
    load_manifest(&app, &backup_id)
}

#[tauri::command]
pub fn restore_profile_backup(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<RestoreResult, String> {
    let manifest = load_manifest(&app, &backup_id)?;
    let data_root = security::platform_data_root()?;
    let slicer = super::descriptor(&manifest.slicer_id)?;
    let allowed_root = data_root.join(slicer.data_dir_name);
    let (restored_files, deleted_files) = restore_backup_inner(&manifest, &allowed_root)?;
    Ok(RestoreResult {
        restored_files,
        deleted_files,
    })
}

#[tauri::command]
pub fn delete_profile_backup(app: tauri::AppHandle, backup_id: String) -> Result<(), String> {
    security::validate_component(&backup_id)?;
    let root = backups_root(&app)?;
    for slicer_dir in std::fs::read_dir(&root)
        .map_err(|e| format!("No backups found: {e}"))?
        .flatten()
    {
        let dir = slicer_dir.path().join(&backup_id);
        if dir.join("manifest.json").is_file() {
            security::ensure_under(&root, &dir)?;
            std::fs::remove_dir_all(&dir).map_err(|e| format!("Delete failed: {e}"))?;
            return Ok(());
        }
    }
    Err(format!("Backup {backup_id} not found"))
}

#[tauri::command]
pub fn open_backup_directory(app: tauri::AppHandle, backup_id: String) -> Result<(), String> {
    let manifest = load_manifest(&app, &backup_id)?;
    let root = backups_root(&app)?;
    super::processes::open_directory_checked(Path::new(&manifest.backup_root), &[root])
}

// ---------------------------------------------------------------------------
// Integration tests — always temp directories, never real slicer data.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    // Restore compares against checksums stored in existing backup manifests,
    // so the digest must stay lowercase hex across sha2 upgrades.
    #[test]
    fn sha256_file_is_lowercase_hex() {
        let p = std::env::temp_dir().join(format!("perfectfit-sha-{}", std::process::id()));
        std::fs::write(&p, b"abc").unwrap();
        let sum = sha256_file(&p).unwrap();
        std::fs::remove_file(&p).ok();
        assert_eq!(sum, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    struct TempUserRoot(PathBuf);
    impl TempUserRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "perfectfit-snapshot-test-{tag}-{}-{}",
                std::process::id(),
                super::super::now_unix()
            ));
            std::fs::create_dir_all(dir.join("user/default/filament/base")).unwrap();
            std::fs::create_dir_all(dir.join("user/default/machine")).unwrap();
            std::fs::create_dir_all(dir.join("user/default/process")).unwrap();
            std::fs::create_dir_all(dir.join("backups")).unwrap();
            TempUserRoot(dir)
        }
        fn user_dir(&self) -> PathBuf {
            self.0.join("user/default")
        }
        fn backups(&self) -> PathBuf {
            self.0.join("backups")
        }
    }
    impl Drop for TempUserRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn snapshot(t: &TempUserRoot) -> Result<ProfileBackupManifest, String> {
        snapshot_user_presets_core(
            &t.backups(),
            "orca",
            "Preset library snapshot (default)",
            "proj-1",
            &t.user_dir(),
        )
    }

    #[test]
    fn snapshot_covers_filament_machine_process_and_skips_caches() {
        let t = TempUserRoot::new("scope");
        let u = t.user_dir();
        std::fs::write(u.join("filament/My PLA.json"), "{\"a\":1}").unwrap();
        std::fs::write(u.join("filament/My PLA.info"), "sync_info =\n").unwrap();
        std::fs::write(u.join("machine/My Printer.json"), "{\"b\":2}").unwrap();
        std::fs::write(u.join("process/0.20 Standard.json"), "{\"c\":3}").unwrap();
        // Must be ignored: base/ cache, non-preset extensions.
        std::fs::write(u.join("filament/base/Cloud PLA.json"), "{\"cache\":true}").unwrap();
        std::fs::write(u.join("filament/notes.txt"), "not a preset").unwrap();

        let m = snapshot(&t).unwrap();
        assert_eq!(m.files.len(), 4, "filament json+info, machine, process");
        assert!(m.files.iter().all(|f| f.existed_before));
        for f in &m.files {
            assert!(!f.original_path.contains("base"), "cache leaked into snapshot: {}", f.original_path);
            assert!(!f.original_path.ends_with(".txt"));
        }
    }

    #[test]
    fn snapshot_restore_round_trip_recovers_edited_and_deleted_presets() {
        let t = TempUserRoot::new("roundtrip");
        let u = t.user_dir();
        let filament = u.join("filament/My PLA.json");
        let machine = u.join("machine/My Printer.json");
        std::fs::write(&filament, "{\"flow\":\"0.98\"}").unwrap();
        std::fs::write(&machine, "{\"retract\":\"0.8\"}").unwrap();

        let m = snapshot(&t).unwrap();

        // Simulate what a calibration session can do: edit one file, delete another.
        std::fs::write(&filament, "{\"flow\":\"1.15\"}").unwrap();
        std::fs::remove_file(&machine).unwrap();

        let (restored, deleted) = restore_backup_inner(&m, &t.0).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(deleted.is_empty());
        assert_eq!(std::fs::read_to_string(&filament).unwrap(), "{\"flow\":\"0.98\"}");
        assert_eq!(std::fs::read_to_string(&machine).unwrap(), "{\"retract\":\"0.8\"}");
    }

    #[test]
    fn empty_library_is_an_error_and_creates_no_backup() {
        let t = TempUserRoot::new("empty");
        let err = snapshot(&t).err().expect("empty library must not snapshot");
        assert!(err.contains("nothing to back up"), "{err}");
        assert_eq!(std::fs::read_dir(t.backups()).unwrap().count(), 0);
    }

    #[test]
    fn oversized_files_are_skipped() {
        let t = TempUserRoot::new("oversize");
        let u = t.user_dir();
        std::fs::write(u.join("filament/ok.json"), "{}").unwrap();
        std::fs::write(
            u.join("filament/huge.json"),
            vec![b' '; (MAX_SNAPSHOT_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        let m = snapshot(&t).unwrap();
        assert_eq!(m.files.len(), 1);
        assert!(m.files[0].original_path.ends_with("ok.json"));
    }
}
