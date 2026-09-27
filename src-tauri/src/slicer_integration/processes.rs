//! Process detection and launching. Detection uses verified process image
//! names per slicer (never window titles). We never terminate anything.

use super::{descriptor, security};
use std::path::Path;
use std::process::Command;

#[cfg(target_os = "windows")]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(target_os = "windows"))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// List running process image names, lowercased.
fn running_processes() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let out = no_window(Command::new("tasklist").args(["/FO", "CSV", "/NH"]))
            .output()
            .map_err(|e| format!("tasklist failed: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(text
            .lines()
            .filter_map(|l| l.split('"').nth(1))
            .map(|s| s.to_ascii_lowercase())
            .collect())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("ps")
            .args(["-axo", "comm="])
            .output()
            .map_err(|e| format!("ps failed: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(text
            .lines()
            .filter_map(|l| l.rsplit('/').next())
            .map(|s| s.trim().to_ascii_lowercase())
            .collect())
    }
}

pub fn is_slicer_running(slicer_id: &str) -> Result<bool, String> {
    let s = descriptor(slicer_id)?;
    let procs = running_processes()?;
    Ok(procs.iter().any(|p| {
        s.process_names
            .iter()
            .any(|n| p == &n.to_ascii_lowercase())
    }))
}

#[tauri::command]
pub fn detect_running_slicer_process(slicer_id: String) -> Result<bool, String> {
    is_slicer_running(&slicer_id)
}

/// Launch a detected slicer executable (never an arbitrary path).
#[tauri::command]
pub fn open_slicer(slicer_id: String) -> Result<(), String> {
    let s = descriptor(&slicer_id)?;
    for root in security::program_roots() {
        #[cfg(target_os = "windows")]
        for cand in s.windows_exe_candidates {
            let p = root.join(cand);
            if p.is_file() {
                Command::new(&p)
                    .spawn()
                    .map_err(|e| format!("Failed to launch: {e}"))?;
                return Ok(());
            }
        }
        #[cfg(target_os = "macos")]
        for cand in s.macos_app_candidates {
            let p = root.join(cand);
            if p.exists() {
                Command::new("open")
                    .arg(&p)
                    .spawn()
                    .map_err(|e| format!("Failed to launch: {e}"))?;
                return Ok(());
            }
        }
        // Linux candidates are directly executable files (native binary or an
        // AppImage `AppRun`), so they are spawned like the Windows ones — no
        // `open`/`xdg-open` wrapper, which would only be needed for a bundle
        // or a .desktop entry.
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        for cand in s.linux_exe_candidates {
            let p = root.join(cand);
            if p.is_file() {
                Command::new(&p)
                    .spawn()
                    .map_err(|e| format!("Failed to launch: {e}"))?;
                return Ok(());
            }
        }
    }
    Err("SLICER_NOT_FOUND: executable not detected".into())
}

/// Open a directory in the OS file manager. Restricted to slicer data
/// directories and the PerfectFit backup root.
pub fn open_directory_checked(path: &Path, allowed_roots: &[std::path::PathBuf]) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", path.display()));
    }
    let mut ok = false;
    for root in allowed_roots {
        if root.is_dir() && security::ensure_under(root, path).is_ok() {
            ok = true;
            break;
        }
    }
    if !ok {
        return Err("Directory is outside allowed locations".into());
    }
    #[cfg(target_os = "windows")]
    {
        no_window(Command::new("explorer").arg(path))
            .spawn()
            .map_err(|e| format!("Failed to open directory: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {e}"))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {e}"))?;
    }
    Ok(())
}

/// Open an http/https URL in the user's default browser. Only web URLs are
/// accepted — never file paths, custom schemes, or anything with control
/// characters — and arguments are passed as a single argv (no shell), so there
/// is no shell-metacharacter injection surface. Needed because `target="_blank"`
/// anchors do nothing inside the webview.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http(s) links can be opened".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("Link contains invalid characters".into());
    }
    #[cfg(target_os = "windows")]
    {
        // explorer.exe launches the default browser for a web URL and, unlike
        // `cmd /C start`, does not go through a shell.
        no_window(Command::new("explorer").arg(trimmed))
            .spawn()
            .map_err(|e| format!("Failed to open link: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open link: {e}"))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open link: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_profile_directory(path: String) -> Result<(), String> {
    let data_root = security::platform_data_root()?;
    let allowed: Vec<std::path::PathBuf> = super::SLICERS
        .iter()
        .map(|s| data_root.join(s.data_dir_name))
        .collect();
    open_directory_checked(Path::new(&path), &allowed)
}
