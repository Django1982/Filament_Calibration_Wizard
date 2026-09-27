//! Resolve an Orca printer/process/filament preset into a flat settings object
//! for automated slicing (Stage 6 increment 2a).
//!
//! Orca presets live under `resources/profiles/<Vendor>/{machine,process,
//! filament}/*.json`. Each declares a `name`, optional `inherits` (the parent's
//! name), and setting keys. A user-selectable leaf resolves by walking its
//! `inherits` chain and overlaying each descendant's keys on its parent's
//! (a child key replaces the parent's value outright — arrays included).
//!
//! Crucially, the base presets a chain inherits (`fdm_machine_common`,
//! `Bambu PLA Basic @base`, …) are **vendor-local**: every vendor folder ships
//! its own copy, so resolution never searches across vendors. We index (or
//! direct-open) one vendor's type folder and resolve within it.
//!
//! The three resolved objects (machine ∪ process ∪ filament) combine into one
//! flat object shaped like `project_settings.config`, ready for the TS side to
//! layer the session's calibrated filament values onto. No preset file is ever
//! written; this only reads under the vetted engine's own resources root.

use super::{engine, security};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Plumbing keys that describe a preset's identity/inheritance rather than a
/// slicer setting — dropped from the combined flat config.
const PLUMBING_KEYS: &[&str] = &[
    "name",
    "type",
    "inherits",
    "from",
    "setting_id",
    "instantiation",
    "filament_id",
    "user_id",
    "version",
];

/// Fallback filament colour written when the resolved config carries none.
/// Orca's own default for a freshly-added filament; any valid hex works — the
/// value is cosmetic, it only has to exist (see `ensure_filament_colour`).
const DEFAULT_FILAMENT_COLOUR: &str = "#00AE42";

/// Orca's GUI project-load path builds per-object/per-extruder colour data from
/// `filament_colour`. Our resolved config comes from Orca's SYSTEM filament
/// presets, which carry no per-instance colour (that is assigned when a user
/// adds the filament to a printer), so the key is absent — and loading a project
/// whose filament has no colour makes Orca dereference a null while colouring
/// the plate's objects, crashing the GUI on load (an ACCESS_VIOLATION inside
/// OpenCASCADE `BRepExtrema_SelfIntersection`). Headless `--slice` never reads
/// colour, so it slices fine regardless — which is why this only ever surfaced
/// when opening an assembled project in the GUI. Guarantee a concrete colour per
/// filament slot. See HQ CALIBRATION_TEST_FINDINGS.md §4.
fn ensure_filament_colour(flat: &mut Map<String, Value>) {
    let present = matches!(
        flat.get("filament_colour"),
        Some(Value::Array(a))
            if !a.is_empty()
                && a.iter().all(|c| c.as_str().is_some_and(|s| !s.trim().is_empty()))
    );
    if present {
        return;
    }
    // Single-filament calibration -> mirror the filament slot count (filament_settings_id).
    let slots = flat
        .get("filament_settings_id")
        .and_then(|v| v.as_array())
        .map(|a| a.len().max(1))
        .unwrap_or(1);
    flat.insert(
        "filament_colour".into(),
        Value::Array(vec![Value::String(DEFAULT_FILAMENT_COLOUR.to_string()); slots]),
    );
}

/// Orca's GUI matches a project's filament to an installed system preset through
/// the `filament_extruder_variant` legend (one entry per hardware hotend-variant
/// slot) paired with `filament_self_index` (which maps each legend slot to a
/// filament number). Our resolved config carries the variant legend (it lives in
/// the system filament preset) but NOT the self-index — Orca generates that only
/// when a filament is instantiated into a printer's slots. Without it the GUI
/// rejects the whole project config ("invalid config file … can not find suitable
/// filament_extruder_variant or filament_self_index") and loads an EMPTY bed;
/// headless `--slice` ignores it entirely. A single-filament calibration means
/// every legend slot maps to the one filament (index 1). See HQ
/// CALIBRATION_TEST_FINDINGS.md §4.
fn ensure_filament_self_index(flat: &mut Map<String, Value>) {
    let present = matches!(
        flat.get("filament_self_index"),
        Some(Value::Array(a)) if !a.is_empty()
    );
    if present {
        return;
    }
    // Only Bambu-lineage configs carry the variant legend; when it is absent the
    // GUI does not require a self-index, so add nothing.
    let variant_len = match flat.get("filament_extruder_variant") {
        Some(Value::Array(a)) if !a.is_empty() => a.len(),
        _ => return,
    };
    flat.insert(
        "filament_self_index".into(),
        Value::Array(vec![Value::String("1".into()); variant_len]),
    );
}

/// Reject a preset/vendor name that could traverse out of its folder. Preset
/// names legitimately contain spaces, `@`, `.`, and parentheses, so we only bar
/// path separators, `..`, control characters, and empties.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Empty preset name".into());
    }
    if name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("Illegal preset name: {name:?}"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(format!("Preset name has control characters: {name:?}"));
    }
    Ok(())
}

/// A single vendor/type preset folder with a lazily-built name→path index.
struct PresetDir {
    dir: PathBuf,
    index: Option<HashMap<String, PathBuf>>,
}

impl PresetDir {
    fn new(dir: PathBuf) -> Self {
        PresetDir { dir, index: None }
    }

    /// Full scan: map each json's declared `name` to its path.
    fn build_index(&self) -> HashMap<String, PathBuf> {
        let mut m = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(txt) = std::fs::read_to_string(&p) {
                    if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                        if let Some(n) = v.get("name").and_then(|x| x.as_str()) {
                            m.insert(n.to_string(), p);
                        }
                    }
                }
            }
        }
        m
    }

    /// Locate a preset by name. Preset filenames normally equal the preset name,
    /// so try `<dir>/<name>.json` first and only scan the folder as a fallback.
    fn find(&mut self, name: &str) -> Result<PathBuf, String> {
        validate_name(name)?;
        let direct = self.dir.join(format!("{name}.json"));
        if direct.is_file() {
            security::ensure_under(&self.dir, &direct)?;
            return Ok(direct);
        }
        if self.index.is_none() {
            self.index = Some(self.build_index());
        }
        let path = self
            .index
            .as_ref()
            .and_then(|m| m.get(name))
            .cloned()
            .ok_or_else(|| format!("Preset '{name}' not found in {}", self.dir.display()))?;
        security::ensure_under(&self.dir, &path)?;
        Ok(path)
    }

    /// Resolve a preset's full `inherits` chain into a flat map.
    fn resolve(&mut self, name: &str) -> Result<Map<String, Value>, String> {
        let mut visited = HashSet::new();
        self.resolve_inner(name, &mut visited, 0)
    }

    /// Collect the first value found for each requested field walking `name`'s
    /// `inherits` chain (child overrides parent). Cheaper than `resolve` when only
    /// a few fields are needed, and `cache` lets shared ancestors (e.g. a common
    /// base every leaf inherits) be parsed just once across many leaves. Missing
    /// files and cycles end the walk quietly rather than erroring — this is used
    /// for best-effort metadata (filament type/vendor/compatibility).
    fn collect_fields(
        &mut self,
        name: &str,
        fields: &[&str],
        cache: &mut HashMap<PathBuf, Value>,
        out: &mut Map<String, Value>,
        depth: usize,
    ) {
        if depth > 32 {
            return;
        }
        let Ok(path) = self.find(name) else { return };
        let value = match cache.get(&path) {
            Some(v) => v.clone(),
            None => {
                let Ok(txt) = std::fs::read_to_string(&path) else { return };
                let Ok(v) = serde_json::from_str::<Value>(&txt) else { return };
                cache.insert(path.clone(), v.clone());
                v
            }
        };
        let Some(obj) = value.as_object() else { return };
        for &f in fields {
            if !out.contains_key(f) {
                if let Some(val) = obj.get(f) {
                    out.insert(f.to_string(), val.clone());
                }
            }
        }
        if let Some(parent) = obj.get("inherits").and_then(|x| x.as_str()) {
            self.collect_fields(parent, fields, cache, out, depth + 1);
        }
    }

    fn resolve_inner(
        &mut self,
        name: &str,
        visited: &mut HashSet<String>,
        depth: usize,
    ) -> Result<Map<String, Value>, String> {
        if depth > 32 {
            return Err(format!("inherits chain too deep at '{name}'"));
        }
        if !visited.insert(name.to_string()) {
            return Err(format!("inherits cycle detected at '{name}'"));
        }
        let path = self.find(name)?;
        let txt = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        let value: Value = serde_json::from_str(&txt).map_err(|e| format!("Bad preset JSON {}: {e}", path.display()))?;
        let obj = value
            .as_object()
            .ok_or_else(|| format!("Preset {} is not a JSON object", path.display()))?;

        let mut base = match obj.get("inherits").and_then(|x| x.as_str()) {
            Some(parent) => self.resolve_inner(parent, visited, depth + 1)?,
            None => Map::new(),
        };
        // Child keys overlay (replace) the parent's.
        for (k, v) in obj {
            base.insert(k.clone(), v.clone());
        }
        Ok(base)
    }
}

#[derive(Serialize, Clone)]
pub struct RawResolvedPreset {
    /// The flat combined settings, JSON-serialized (shaped like project_settings.config).
    pub settings_json: String,
    pub printer_model: Option<String>,
    pub printer_settings_id: String,
    pub print_settings_id: String,
    pub filament_settings_id: String,
    pub machine_key_count: usize,
    pub process_key_count: usize,
    pub filament_key_count: usize,
    pub warnings: Vec<String>,
}

/// Combine three resolved preset maps into one flat config. Namespaces are
/// largely disjoint; on the rare overlap, precedence is machine < process <
/// filament (filament, the innermost per-material choice, wins). Plumbing keys
/// are dropped and the settings-id fields are set from the leaf names.
fn combine(
    machine: Map<String, Value>,
    process: Map<String, Value>,
    filament: Map<String, Value>,
    machine_name: &str,
    process_name: &str,
    filament_name: &str,
) -> (Map<String, Value>, Option<String>) {
    let (mc, pc, fc) = (machine.len(), process.len(), filament.len());
    let printer_model = machine
        .get("printer_model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut flat = Map::new();
    for (k, v) in machine {
        flat.insert(k, v);
    }
    for (k, v) in process {
        flat.insert(k, v);
    }
    for (k, v) in filament {
        flat.insert(k, v);
    }
    for k in PLUMBING_KEYS {
        flat.remove(*k);
    }
    let _ = (mc, pc, fc);
    flat.insert("printer_settings_id".into(), Value::String(machine_name.to_string()));
    flat.insert("print_settings_id".into(), Value::String(process_name.to_string()));
    flat.insert(
        "filament_settings_id".into(),
        Value::Array(vec![Value::String(filament_name.to_string())]),
    );
    ensure_filament_colour(&mut flat);
    ensure_filament_self_index(&mut flat);
    (flat, printer_model)
}

/// Resolve a printer/process/filament selection (by exact Orca preset names)
/// into a flat `project_settings.config`-shaped object. Reads only under the
/// vetted engine's own `resources/profiles/<vendor>/`.
#[tauri::command]
pub fn resolve_printer_preset(
    engine_id: String,
    vendor: String,
    machine_name: String,
    process_name: String,
    filament_name: String,
) -> Result<RawResolvedPreset, String> {
    validate_name(&vendor)?;
    let resources = engine::engine_resources_root(&engine_id)
        .ok_or_else(|| "Engine resources root unknown — detect the engine first".to_string())?;
    let vendor_dir = resources.join("profiles").join(&vendor);
    if !vendor_dir.is_dir() {
        return Err(format!("Unknown vendor profile folder: {}", vendor_dir.display()));
    }
    security::ensure_under(&resources, &vendor_dir)?;

    let machine = PresetDir::new(vendor_dir.join("machine")).resolve(&machine_name)?;
    let process = PresetDir::new(vendor_dir.join("process")).resolve(&process_name)?;
    let filament = PresetDir::new(vendor_dir.join("filament")).resolve(&filament_name)?;
    let (mc, pc, fc) = (machine.len(), process.len(), filament.len());

    let (flat, printer_model) = combine(
        machine,
        process,
        filament,
        &machine_name,
        &process_name,
        &filament_name,
    );

    let mut warnings = Vec::new();
    if printer_model.is_none() {
        warnings.push("Resolved machine preset has no printer_model.".into());
    }
    if !flat.contains_key("nozzle_diameter") {
        warnings.push("Resolved config has no nozzle_diameter.".into());
    }

    let settings_json = serde_json::to_string(&Value::Object(flat)).map_err(|e| format!("Serialize failed: {e}"))?;
    Ok(RawResolvedPreset {
        settings_json,
        printer_model,
        printer_settings_id: machine_name,
        print_settings_id: process_name,
        filament_settings_id: filament_name,
        machine_key_count: mc,
        process_key_count: pc,
        filament_key_count: fc,
        warnings,
    })
}

/// Identity of one user-selectable (instantiation) machine preset, for mapping
/// a PerfectFit printer selection to the Orca preset names the resolver needs.
#[derive(Serialize, Clone)]
pub struct RawMachinePreset {
    pub vendor: String,
    pub name: String,
    pub printer_model: Option<String>,
    pub nozzle_diameter: Option<String>,
    pub default_print_profile: Option<String>,
    pub default_filament_profile: Option<String>,
}

/// First string of a field that may be a bare string or an array of strings.
fn first_string(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(a)) => a.first().and_then(|x| x.as_str()).map(|s| s.to_string()),
        _ => None,
    }
}

/// Enumerate the installed slicer's user-selectable machine presets across all
/// vendors, so the frontend can map a printer selection to (vendor, machine,
/// process). Read-only, under the vetted engine's resources root.
#[tauri::command]
pub fn list_installed_machines(engine_id: String) -> Result<Vec<RawMachinePreset>, String> {
    let resources = engine::engine_resources_root(&engine_id)
        .ok_or_else(|| "Engine resources root unknown — detect the engine first".to_string())?;
    let profiles = resources.join("profiles");
    let mut out = Vec::new();
    let Ok(vendors) = std::fs::read_dir(&profiles) else {
        return Ok(out);
    };
    for v in vendors.flatten() {
        let vpath = v.path();
        if !vpath.is_dir() {
            continue;
        }
        let vendor = v.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(vpath.join("machine")) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(txt) = std::fs::read_to_string(&p) else {
                continue;
            };
            let Ok(val) = serde_json::from_str::<Value>(&txt) else {
                continue;
            };
            // Only user-selectable leaves (bases are instantiation-absent/false).
            if val.get("instantiation").and_then(|x| x.as_str()) != Some("true") {
                continue;
            }
            out.push(RawMachinePreset {
                vendor: vendor.clone(),
                name: val.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                printer_model: val.get("printer_model").and_then(|x| x.as_str()).map(|s| s.to_string()),
                nozzle_diameter: first_string(&val, "nozzle_diameter"),
                default_print_profile: first_string(&val, "default_print_profile"),
                default_filament_profile: first_string(&val, "default_filament_profile"),
            });
        }
    }
    Ok(out)
}

/// Identity + material metadata of one user-selectable filament preset, for
/// mapping a chosen material to an Orca filament leaf the resolver can use.
#[derive(Serialize, Clone)]
pub struct RawFilamentPreset {
    pub vendor: String,
    pub name: String,
    pub filament_type: Option<String>,
    pub filament_vendor: Option<String>,
    /// Machine leaf names this filament declares compatibility with. Empty means
    /// Orca treats it as compatible with every printer (see `universal`).
    pub compatible_printers: Vec<String>,
    pub universal: bool,
}

/// First string of a value that may be a bare string or an array of strings.
fn first_str_val(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(a)) => a.first().and_then(|x| x.as_str()).map(|s| s.to_string()),
        _ => None,
    }
}

/// A field that may be a string, an array of strings, or absent → a Vec.
fn string_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Enumerate one vendor's user-selectable (`instantiation == "true"`) filament
/// presets, optionally filtered to those compatible with a given machine leaf.
/// A calibration tunes the filament, so the material/filament is a selection the
/// caller supplies separately from the printer — this backs that selection.
/// Read-only, under the vetted engine's resources root; filament type/vendor are
/// resolved through the `inherits` chain (they usually live on a shared base).
#[tauri::command]
pub fn list_vendor_filaments(
    engine_id: String,
    vendor: String,
    machine_name: Option<String>,
) -> Result<Vec<RawFilamentPreset>, String> {
    validate_name(&vendor)?;
    let resources = engine::engine_resources_root(&engine_id)
        .ok_or_else(|| "Engine resources root unknown — detect the engine first".to_string())?;
    let vendor_dir = resources.join("profiles").join(&vendor);
    if !vendor_dir.is_dir() {
        return Err(format!("Unknown vendor profile folder: {}", vendor_dir.display()));
    }
    security::ensure_under(&resources, &vendor_dir)?;
    let filament_dir = vendor_dir.join("filament");

    let mut presets = PresetDir::new(filament_dir.clone());
    let mut cache: HashMap<PathBuf, Value> = HashMap::new();
    let mut out = Vec::new();
    let want = ["filament_type", "filament_vendor", "compatible_printers"];

    let Ok(files) = std::fs::read_dir(&filament_dir) else {
        return Ok(out);
    };
    for f in files.flatten() {
        let p = f.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(&p) else { continue };
        let Ok(val) = serde_json::from_str::<Value>(&txt) else { continue };
        if val.get("instantiation").and_then(|x| x.as_str()) != Some("true") {
            continue;
        }
        let Some(name) = val.get("name").and_then(|x| x.as_str()) else { continue };

        // Cheap pre-filter: if the leaf itself lists compatible printers and the
        // requested machine isn't among them, reject without walking the chain.
        let leaf_compat = string_list(val.get("compatible_printers"));
        if let Some(machine) = machine_name.as_deref() {
            if !leaf_compat.is_empty() && !leaf_compat.iter().any(|m| m == machine) {
                continue;
            }
        }

        // Resolve type/vendor/compat through the inherits chain (child wins).
        cache.entry(p.clone()).or_insert_with(|| val.clone());
        let mut collected = Map::new();
        presets.collect_fields(name, &want, &mut cache, &mut collected, 0);

        let compatible_printers = string_list(collected.get("compatible_printers"));
        let universal = compatible_printers.is_empty();
        if let Some(machine) = machine_name.as_deref() {
            if !universal && !compatible_printers.iter().any(|m| m == machine) {
                continue;
            }
        }

        out.push(RawFilamentPreset {
            vendor: vendor.clone(),
            name: name.to_string(),
            filament_type: first_str_val(collected.get("filament_type")),
            filament_vendor: first_str_val(collected.get("filament_vendor")),
            compatible_printers,
            universal,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pf_resolver_{tag}_{n}_{}", super::super::now_unix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_preset(dir: &PathBuf, name: &str, json: &str) {
        std::fs::write(dir.join(format!("{name}.json")), json).unwrap();
    }

    #[test]
    fn resolves_a_chain_child_overrides_parent() {
        let d = temp_dir("chain");
        // base -> mid -> leaf; leaf overrides a key, mid adds one, base has two.
        write_preset(&d, "base", r#"{"name":"base","a":"1","b":"1"}"#);
        write_preset(&d, "mid", r#"{"name":"mid","inherits":"base","b":"2","c":"2"}"#);
        write_preset(&d, "leaf", r#"{"name":"leaf","inherits":"mid","a":"3"}"#);
        let resolved = PresetDir::new(d.clone()).resolve("leaf").unwrap();
        assert_eq!(resolved.get("a").unwrap(), "3"); // leaf wins
        assert_eq!(resolved.get("b").unwrap(), "2"); // mid wins over base
        assert_eq!(resolved.get("c").unwrap(), "2"); // from mid
        assert_eq!(resolved.get("inherits").unwrap(), "mid"); // still present pre-combine
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn arrays_are_replaced_not_merged() {
        let d = temp_dir("arr");
        write_preset(&d, "base", r#"{"name":"base","nozzle_temperature":["200","200"]}"#);
        write_preset(&d, "leaf", r#"{"name":"leaf","inherits":"base","nozzle_temperature":["220"]}"#);
        let r = PresetDir::new(d.clone()).resolve("leaf").unwrap();
        assert_eq!(r.get("nozzle_temperature").unwrap(), &serde_json::json!(["220"]));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn detects_cycles_and_missing() {
        let d = temp_dir("cycle");
        write_preset(&d, "x", r#"{"name":"x","inherits":"y"}"#);
        write_preset(&d, "y", r#"{"name":"y","inherits":"x"}"#);
        assert!(PresetDir::new(d.clone()).resolve("x").unwrap_err().contains("cycle"));
        assert!(PresetDir::new(d.clone()).resolve("nope").unwrap_err().contains("not found"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn find_falls_back_to_scan_when_filename_differs() {
        let d = temp_dir("scan");
        // filename does NOT match the declared name.
        std::fs::write(d.join("weirdfile.json"), r#"{"name":"Real Name","k":"v"}"#).unwrap();
        let r = PresetDir::new(d.clone()).resolve("Real Name").unwrap();
        assert_eq!(r.get("k").unwrap(), "v");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn rejects_traversal_names() {
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name("0.20mm Standard @BBL X1C").is_ok()); // legit chars allowed
    }

    #[test]
    fn combine_drops_plumbing_and_sets_ids() {
        let mut machine = Map::new();
        machine.insert("name".into(), serde_json::json!("M"));
        machine.insert("inherits".into(), serde_json::json!("base"));
        machine.insert("printer_model".into(), serde_json::json!("My Printer"));
        machine.insert("nozzle_diameter".into(), serde_json::json!(["0.4"]));
        let mut process = Map::new();
        process.insert("layer_height".into(), serde_json::json!("0.2"));
        let mut filament = Map::new();
        filament.insert("filament_flow_ratio".into(), serde_json::json!(["1"]));

        let (flat, model) = combine(machine, process, filament, "M4", "P02", "PLA");
        assert_eq!(model.as_deref(), Some("My Printer"));
        assert!(!flat.contains_key("name") && !flat.contains_key("inherits"));
        assert_eq!(flat.get("printer_settings_id").unwrap(), "M4");
        assert_eq!(flat.get("print_settings_id").unwrap(), "P02");
        assert_eq!(flat.get("filament_settings_id").unwrap(), &serde_json::json!(["PLA"]));
        assert_eq!(flat.get("layer_height").unwrap(), "0.2");
        assert_eq!(flat.get("filament_flow_ratio").unwrap(), &serde_json::json!(["1"]));
    }

    #[test]
    fn combine_adds_default_filament_colour_when_absent() {
        // System filament presets carry no per-instance colour; the combined
        // config must still get one per slot, or Orca's GUI crashes on load.
        let (flat, _) = combine(Map::new(), Map::new(), Map::new(), "M4", "P02", "PLA");
        assert_eq!(
            flat.get("filament_colour").unwrap(),
            &serde_json::json!([DEFAULT_FILAMENT_COLOUR]),
            "one colour per filament slot (single-filament calibration -> 1 slot)"
        );
    }

    #[test]
    fn combine_keeps_existing_filament_colour() {
        // A resolved preset that already declares a real colour is left untouched.
        let mut filament = Map::new();
        filament.insert("filament_colour".into(), serde_json::json!(["#123456"]));
        let (flat, _) = combine(Map::new(), Map::new(), filament, "M4", "P02", "PLA");
        assert_eq!(flat.get("filament_colour").unwrap(), &serde_json::json!(["#123456"]));
    }

    #[test]
    fn combine_replaces_blank_filament_colour() {
        // An empty/blank colour is as fatal as a missing one — replace it.
        let mut filament = Map::new();
        filament.insert("filament_colour".into(), serde_json::json!([""]));
        let (flat, _) = combine(Map::new(), Map::new(), filament, "M4", "P02", "PLA");
        assert_eq!(flat.get("filament_colour").unwrap(), &serde_json::json!([DEFAULT_FILAMENT_COLOUR]));
    }

    #[test]
    fn combine_adds_self_index_matching_the_variant_legend() {
        // A single-filament calibration -> every extruder-variant slot maps to
        // filament 1, so self_index is a run of "1"s the length of the legend.
        let mut machine = Map::new();
        machine.insert(
            "filament_extruder_variant".into(),
            serde_json::json!(["Direct Drive Standard", "Direct Drive High Flow"]),
        );
        let (flat, _) = combine(machine, Map::new(), Map::new(), "M4", "P02", "PLA");
        assert_eq!(flat.get("filament_self_index").unwrap(), &serde_json::json!(["1", "1"]));
    }

    #[test]
    fn combine_omits_self_index_without_a_variant_legend() {
        // Non-Bambu configs carry no variant legend; the GUI doesn't need a
        // self-index there, so none is invented.
        let (flat, _) = combine(Map::new(), Map::new(), Map::new(), "M4", "P02", "PLA");
        assert!(!flat.contains_key("filament_self_index"));
    }

    #[test]
    fn combine_keeps_existing_self_index() {
        let mut filament = Map::new();
        filament.insert("filament_extruder_variant".into(), serde_json::json!(["A", "B"]));
        filament.insert("filament_self_index".into(), serde_json::json!(["1", "2"]));
        let (flat, _) = combine(Map::new(), Map::new(), filament, "M4", "P02", "PLA");
        assert_eq!(flat.get("filament_self_index").unwrap(), &serde_json::json!(["1", "2"]));
    }

    #[test]
    fn collect_fields_walks_chain_child_wins() {
        let d = temp_dir("collect");
        write_preset(&d, "fdm_filament_pla", r#"{"name":"fdm_filament_pla","filament_type":"PLA"}"#);
        write_preset(
            &d,
            "Base",
            r#"{"name":"Base","inherits":"fdm_filament_pla","filament_vendor":["Generic"],"compatible_printers":[]}"#,
        );
        write_preset(
            &d,
            "Leaf",
            r#"{"name":"Leaf","inherits":"Base","compatible_printers":["My Printer 0.4 nozzle"]}"#,
        );
        let mut dir = PresetDir::new(d.clone());
        let mut cache = HashMap::new();
        let mut out = Map::new();
        dir.collect_fields(
            "Leaf",
            &["filament_type", "filament_vendor", "compatible_printers"],
            &mut cache,
            &mut out,
            0,
        );
        assert_eq!(first_str_val(out.get("filament_type")).as_deref(), Some("PLA")); // from grandparent
        assert_eq!(first_str_val(out.get("filament_vendor")).as_deref(), Some("Generic")); // from parent
        // leaf's non-empty compatible_printers wins over the parent's empty one
        assert_eq!(string_list(out.get("compatible_printers")), vec!["My Printer 0.4 nozzle"]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn string_list_and_first_str_handle_scalar_array_and_missing() {
        assert_eq!(first_str_val(Some(&serde_json::json!("x"))).as_deref(), Some("x"));
        assert_eq!(first_str_val(Some(&serde_json::json!(["a", "b"]))).as_deref(), Some("a"));
        assert_eq!(first_str_val(None), None);
        assert_eq!(string_list(Some(&serde_json::json!(["a", "b"]))), vec!["a", "b"]);
        assert_eq!(string_list(Some(&serde_json::json!("solo"))), vec!["solo"]);
        assert!(string_list(None).is_empty());
    }

    /// Supervised: list real BBL filaments compatible with the X1 Carbon 0.4
    /// nozzle and confirm a PLA leaf appears and resolves. Run with
    /// `cargo test -- --ignored probe_real_vendor_filaments`.
    #[test]
    #[ignore]
    fn probe_real_vendor_filaments() {
        let prof = crate::slicer_integration::test_support::orca_profiles("BBL");
        if !prof.is_dir() {
            eprintln!("SKIP: BBL profiles not present");
            return;
        }
        // Emulate list_vendor_filaments filtered to the X1C 0.4 nozzle machine.
        let machine = "Bambu Lab X1 Carbon 0.4 nozzle";
        let filament_dir = prof.join("filament");
        let mut presets = PresetDir::new(filament_dir.clone());
        let mut cache: HashMap<PathBuf, Value> = HashMap::new();
        let want = ["filament_type", "filament_vendor", "compatible_printers"];
        let mut pla = Vec::new();
        let mut total = 0usize;
        for f in std::fs::read_dir(&filament_dir).unwrap().flatten() {
            let p = f.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let val: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap_or(Value::Null);
            if val.get("instantiation").and_then(|x| x.as_str()) != Some("true") {
                continue;
            }
            let name = val.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let leaf_compat = string_list(val.get("compatible_printers"));
            if !leaf_compat.is_empty() && !leaf_compat.iter().any(|m| m == machine) {
                continue;
            }
            cache.entry(p.clone()).or_insert_with(|| val.clone());
            let mut collected = Map::new();
            presets.collect_fields(&name, &want, &mut cache, &mut collected, 0);
            let compat = string_list(collected.get("compatible_printers"));
            if !compat.is_empty() && !compat.iter().any(|m| m == machine) {
                continue;
            }
            total += 1;
            if first_str_val(collected.get("filament_type")).as_deref() == Some("PLA") {
                pla.push(name);
            }
        }
        println!("X1C-compatible filaments: {total}, of which PLA: {}", pla.len());
        assert!(total > 0, "should find filaments for the X1C");
        assert!(pla.iter().any(|n| n.contains("Basic")), "expected a Bambu PLA Basic leaf; got {pla:?}");
        // and the resolver accepts one
        let one = pla.iter().find(|n| n.contains("Basic")).unwrap();
        assert!(PresetDir::new(filament_dir).resolve(one).is_ok());
    }

    /// Supervised: does mapping a printer via the installed machine index yield
    /// preset names that actually RESOLVE (incl. the machine's default filament)?
    /// Run with `cargo test -- --ignored probe_real_machine_index`.
    #[test]
    #[ignore]
    fn probe_real_machine_index_and_defaults() {
        let resources = crate::slicer_integration::test_support::orca_resources();
        if !resources.is_dir() {
            eprintln!("SKIP: Orca not present");
            return;
        }
        // Emulate list_installed_machines without a manifest: scan BBL directly.
        let mdir = resources.join("profiles/BBL/machine");
        let mut x1c: Option<(String, String, String)> = None; // (name, process, filament)
        for f in std::fs::read_dir(&mdir).unwrap().flatten() {
            let p = f.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let val: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap_or(Value::Null);
            if val.get("instantiation").and_then(|x| x.as_str()) != Some("true") {
                continue;
            }
            if val.get("name").and_then(|x| x.as_str()) == Some("Bambu Lab X1 Carbon 0.4 nozzle") {
                x1c = Some((
                    "Bambu Lab X1 Carbon 0.4 nozzle".into(),
                    first_string(&val, "default_print_profile").unwrap_or_default(),
                    first_string(&val, "default_filament_profile").unwrap_or_default(),
                ));
            }
        }
        let (machine, process, filament) = x1c.expect("X1 Carbon 0.4 nozzle machine leaf");
        println!("machine='{machine}' default_process='{process}' default_filament='{filament}'");
        assert!(!process.is_empty(), "machine should declare default_print_profile");

        // Do those default names actually resolve?
        let bbl = resources.join("profiles/BBL");
        assert!(PresetDir::new(bbl.join("machine")).resolve(&machine).is_ok());
        assert!(PresetDir::new(bbl.join("process")).resolve(&process).is_ok(), "default process must resolve");
        let filament_resolves = !filament.is_empty()
            && PresetDir::new(bbl.join("filament")).resolve(&filament).is_ok();
        println!("default filament '{filament}' resolves in BBL/filament: {filament_resolves}");
    }

    /// Supervised real-install proof: resolve a real BBL X1 Carbon selection and
    /// confirm the flat config carries that printer's identity — then assemble it
    /// into the pa_pattern project and headless-slice, proving Orca accepts a
    /// PerfectFit-resolved config. Run with
    /// `cargo test -- --ignored probe_real_resolve`.
    #[test]
    #[ignore]
    fn probe_real_resolve_and_slice() {
        use super::super::project_assembly;
        use std::process::{Command, Stdio};
        let prof = crate::slicer_integration::test_support::orca_profiles("BBL");
        if !prof.is_dir() {
            eprintln!("SKIP: BBL profiles not present");
            return;
        }
        let machine = PresetDir::new(prof.join("machine"))
            .resolve("Bambu Lab X1 Carbon 0.4 nozzle")
            .unwrap();
        let process = PresetDir::new(prof.join("process"))
            .resolve("0.20mm Standard @BBL X1C")
            .unwrap();
        let filament = PresetDir::new(prof.join("filament"))
            .resolve("Bambu PLA Basic @BBL X1C")
            .unwrap();
        let (flat, model) = combine(
            machine,
            process,
            filament,
            "Bambu Lab X1 Carbon 0.4 nozzle",
            "0.20mm Standard @BBL X1C",
            "Bambu PLA Basic @BBL X1C",
        );
        println!("resolved printer_model={model:?} keys={}", flat.len());
        assert_eq!(model.as_deref(), Some("Bambu Lab X1 Carbon"));
        assert_eq!(flat.get("nozzle_diameter").unwrap(), &serde_json::json!(["0.4"]));
        assert!(flat.contains_key("machine_start_gcode"), "must carry printer start g-code");
        assert!(flat.contains_key("layer_height"), "must carry process settings");
        assert!(flat.contains_key("filament_flow_ratio"), "must carry filament settings");

        // Assemble into pa_pattern and slice with the RESOLVED X1C config.
        let orca = crate::slicer_integration::test_support::orca_exe();
        let template = crate::slicer_integration::test_support::orca_calib("pressure_advance/pa_pattern.3mf");
        if !orca.is_file() || !template.is_file() {
            eprintln!("resolve OK; SKIP slice (orca/template missing)");
            return;
        }
        let d = temp_dir("resolveslice");
        let cfg = serde_json::to_string(&Value::Object(flat)).unwrap();
        let project = d.join("project.3mf");
        project_assembly::repackage_with_config(&template, &cfg, &project).unwrap();
        let datadir = d.join("datadir");
        let outdir = d.join("out");
        std::fs::create_dir_all(&datadir).unwrap();
        std::fs::create_dir_all(&outdir).unwrap();
        let status = Command::new(&orca)
            .arg("--datadir").arg(&datadir)
            .arg("--outputdir").arg(&outdir)
            .arg("--slice").arg("0")
            .arg(&project)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status()
            .expect("failed to launch orca");
        let gcode = outdir.join("plate_1.gcode");
        println!("orca exit={:?} gcode={} size={:?}", status.code(), gcode.is_file(),
            std::fs::metadata(&gcode).map(|m| m.len()).ok());
        assert!(gcode.is_file(), "resolved-config project should slice");
        std::fs::remove_dir_all(&d).ok();
    }
}
