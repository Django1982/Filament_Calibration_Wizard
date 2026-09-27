pub mod slicer_integration;

use slicer_integration::{
  backup, discovery, engine, filesystem, flow_test, install, model_project, preset_resolver,
  processes, project_assembly,
};

/// Remove service-worker registrations and HTTP caches left behind by previous
/// installs. A cache-first service worker registered by an older version keeps
/// serving that version's index.html, whose hashed bundle no longer exists
/// after an update, wedging the app on the static loading screen. Runs before
/// the webview starts so no files are locked. IndexedDB and Local Storage
/// (user calibration data) are deliberately untouched.
#[cfg(target_os = "windows")]
fn purge_stale_webview_caches() {
  let Ok(local) = std::env::var("LOCALAPPDATA") else { return };
  let profile = std::path::Path::new(&local)
    .join("com.redeemed3d.perfectfit")
    .join("EBWebView")
    .join("Default");
  for dir in ["Service Worker", "Cache", "Code Cache"] {
    let _ = std::fs::remove_dir_all(profile.join(dir));
  }
}

#[cfg(not(target_os = "windows"))]
fn purge_stale_webview_caches() {}

/// Work around a blank/empty window on some Linux setups (notably Wayland).
/// WebKitGTK 2.42+ defaults to a DMABUF-based accelerated renderer that calls
/// `eglGetPlatformDisplay`; when that fails it aborts with
/// "Could not create default EGL display: EGL_BAD_PARAMETER" and the window
/// renders nothing. This bites the bundled AppImage in particular, because it
/// ships its own `libwayland-client` that can be incompatible with the host
/// compositor. Disabling the DMABUF renderer makes WebKitGTK fall back to a
/// path that avoids that EGL init entirely. Only set when the user hasn't
/// expressed a preference, so an explicit override (or an `LD_PRELOAD` of the
/// system libwayland) still wins.
#[cfg(target_os = "linux")]
fn configure_linux_webview_env() {
  if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webview_env() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  configure_linux_webview_env();
  purge_stale_webview_caches();
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      discovery::detect_supported_slicers,
      discovery::get_platform_info,
      filesystem::scan_slicer_profiles,
      processes::detect_running_slicer_process,
      processes::open_slicer,
      processes::open_external_url,
      processes::open_profile_directory,
      backup::backup_slicer_user_presets,
      backup::list_profile_backups,
      backup::get_profile_backup_manifest,
      backup::restore_profile_backup,
      backup::delete_profile_backup,
      backup::open_backup_directory,
      install::install_generated_profile,
      install::verify_generated_profile,
      install::save_exported_profile,
      engine::detect_slicing_engine,
      engine::validate_slicing_engine,
      engine::download_managed_orca,
      engine::run_calibration_slice,
      engine::cancel_calibration_slice,
      engine::open_calibration_project,
      engine::reveal_calibration_output,
      project_assembly::read_project_config,
      project_assembly::assemble_calibration_project,
      preset_resolver::resolve_printer_preset,
      preset_resolver::list_installed_machines,
      preset_resolver::list_vendor_filaments,
      model_project::assemble_temperature_tower,
      flow_test::list_flow_test_objects,
      flow_test::assemble_flow_test,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
