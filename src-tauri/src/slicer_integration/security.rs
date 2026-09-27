//! Path validation. Every native command that touches the filesystem goes
//! through these helpers. The frontend never supplies raw paths for writes —
//! only slicer ids, account ids, and profile names, which are validated and
//! resolved server-side to canonical locations.

use std::path::{Path, PathBuf};

/// Windows reserved device names (invalid as file stems).
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Validate a single path component supplied by the frontend (an account id
/// or a profile file stem). Rejects traversal, separators, control characters,
/// characters invalid on Windows, and reserved names.
pub fn validate_component(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Empty name".into());
    }
    if name.len() > 200 {
        return Err("Name too long".into());
    }
    if name == "." || name == ".." {
        return Err("Path traversal rejected".into());
    }
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return Err("Name may not start/end with spaces or end with a dot".into());
    }
    for c in name.chars() {
        if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            return Err(format!("Invalid character in name: {c:?}"));
        }
    }
    let stem = name.split('.').next().unwrap_or("");
    if RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
        return Err("Reserved name rejected".into());
    }
    Ok(())
}

/// Root under which all slicer user data must live on this platform.
pub fn platform_data_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .map_err(|_| "APPDATA not set".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
            .map_err(|_| "HOME not set".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux (XDG) — detection preserved for completeness; install stays
        // gated by the per-version registry, which has no Linux entries yet.
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map_err(|_| "HOME not set".to_string())
    }
}

/// Root under which PerfectFit keeps its own managed files (engine manifests,
/// per-session slicer working directories, and sliced artifacts). This is
/// PerfectFit's own folder — never a slicer's data directory — so nothing here
/// can collide with or corrupt a slicer install. Created on demand.
///
/// The automated pipeline resolves session/job ids (validated components) to
/// canonical paths *under this root*; the frontend never supplies raw write
/// paths, exactly like the profile-installer side.
pub fn perfectfit_managed_root() -> Result<PathBuf, String> {
    let root = platform_data_root()?.join("PerfectFit");
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Cannot create PerfectFit data root {}: {e}", root.display()))?;
    Ok(root)
}

/// Directory holding persisted engine manifests. Created on demand.
pub fn engines_root() -> Result<PathBuf, String> {
    let dir = perfectfit_managed_root()?.join("engines");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create engines dir {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Resolve the working directory for one calibration job, validating the
/// session and job ids as single path components so neither can traverse out
/// of the managed root. Returns `<root>/sessions/<sessionId>/jobs/<jobId>`.
/// Does not create it — the caller decides which subdirectories it needs.
pub fn job_root(session_id: &str, job_id: &str) -> Result<PathBuf, String> {
    validate_component(session_id)?;
    validate_component(job_id)?;
    let root = perfectfit_managed_root()?;
    let dir = root
        .join("sessions")
        .join(session_id)
        .join("jobs")
        .join(job_id);
    Ok(dir)
}

/// Program-files roots searched for slicer executables.
pub fn program_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            roots.push(PathBuf::from(pf));
        }
        if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
            roots.push(PathBuf::from(pf));
        }
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
    }
    roots
}

/// Canonicalize with tolerance for Windows verbatim prefixes so that
/// starts_with comparisons behave.
fn canon(p: &Path) -> Result<PathBuf, String> {
    let c = std::fs::canonicalize(p).map_err(|e| format!("Cannot canonicalize {}: {e}", p.display()))?;
    Ok(c)
}

/// Ensure `candidate` (which must exist) is inside `root` (which must exist).
pub fn ensure_under(root: &Path, candidate: &Path) -> Result<(), String> {
    let root_c = canon(root)?;
    let cand_c = canon(candidate)?;
    if cand_c.starts_with(&root_c) {
        Ok(())
    } else {
        Err(format!(
            "Path {} escapes allowed root {}",
            cand_c.display(),
            root_c.display()
        ))
    }
}

/// Ensure a *target* path (which may not exist yet) resolves inside `root`:
/// its parent must exist, canonicalize under root, and the final component
/// must be a valid, non-traversing name.
pub fn ensure_target_under(root: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Target has no parent directory".to_string())?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Target has no valid file name".to_string())?;
    validate_component(name)?;
    ensure_under(root, parent)
}

/// Allowed read/write extension for preset files.
pub fn validate_preset_extension(name: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".json") || lower.ends_with(".info") {
        Ok(())
    } else {
        Err(format!("Unsupported file extension: {name}"))
    }
}
