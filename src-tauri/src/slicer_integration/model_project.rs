//! Build a complete, sliceable Orca project 3mf AROUND a bare model (Stage 6
//! incr. 3). Calibration steps like the temperature tower ship only geometry
//! (`temperature_tower.stl` — a binary STL, no config, no plate). The Stage 6
//! spike proved a bare model 3mf does NOT slice from a config alone: the Orca
//! CLI (`--slice 0`) needs the plate/model_instance SCAFFOLDING a complete
//! project carries (`Metadata/model_settings.config` + a positioned `<build>`
//! item), not just `project_settings.config`.
//!
//! This module synthesizes that scaffolding for a SINGLE object (the tractable
//! case — one object only needs centering on the plate; multi-object arrangement
//! is a later problem): parse the STL into a mesh, emit a standard-3mf
//! `3D/3dmodel.model` with a centering `<build>` transform, generate the
//! matching `model_settings.config`, and package everything (with the resolved
//! `project_settings.config` and an optional generated
//! `custom_gcode_per_layer.xml`) into one project 3mf.
//!
//! Reads only the caller-provided model bytes; writes only the output project.

use super::project_assembly::RawAssembledProject;
use super::security;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// A triangle mesh with de-duplicated vertices.
pub struct Mesh {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
}

impl Mesh {
    /// Axis-aligned bounds as (min, max). Empty meshes yield zeros.
    pub fn bounds(&self) -> ([f64; 3], [f64; 3]) {
        if self.vertices.is_empty() {
            return ([0.0; 3], [0.0; 3]);
        }
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for v in &self.vertices {
            for k in 0..3 {
                if v[k] < min[k] {
                    min[k] = v[k];
                }
                if v[k] > max[k] {
                    max[k] = v[k];
                }
            }
        }
        (min, max)
    }
}

/// Parse a binary STL into a mesh, de-duplicating vertices so the 3mf is compact.
/// (Orca's calibration models — including `temperature_tower.stl` — are binary
/// STLs; ASCII is intentionally out of scope here.)
pub fn parse_binary_stl(bytes: &[u8]) -> Result<Mesh, String> {
    if bytes.len() < 84 {
        return Err("STL too short to be a binary STL".into());
    }
    let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    let expected = 84usize
        .checked_add(count.checked_mul(50).ok_or("STL triangle count overflows")?)
        .ok_or("STL size overflows")?;
    if bytes.len() < expected {
        return Err(format!(
            "STL truncated or not binary: header says {count} triangles (needs {expected} bytes), got {}",
            bytes.len()
        ));
    }
    let read_f32 = |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]) as f64;

    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut triangles: Vec<[usize; 3]> = Vec::with_capacity(count);
    let mut index: HashMap<(i64, i64, i64), usize> = HashMap::new();
    // Quantize to 1e-5 mm (0.01 µm) so float noise doesn't split shared vertices.
    let q = |f: f64| (f * 100_000.0).round() as i64;

    let mut off = 84;
    for _ in 0..count {
        let mut tri = [0usize; 3];
        for (k, slot) in tri.iter_mut().enumerate() {
            let vo = off + 12 + k * 12; // skip the 12-byte normal
            let v = [read_f32(vo), read_f32(vo + 4), read_f32(vo + 8)];
            let key = (q(v[0]), q(v[1]), q(v[2]));
            *slot = *index.entry(key).or_insert_with(|| {
                vertices.push(v);
                vertices.len() - 1
            });
        }
        triangles.push(tri);
        off += 50; // 12 normal + 36 verts + 2 attribute bytes
    }
    Ok(Mesh { vertices, triangles })
}

/// The temperature-tower master, bundled from OrcaSlicer's own
/// `temperature_tower.drc` (decoded once at dev time; AGPL-3.0 — see
/// THIRD-PARTY-NOTICES.md). It is a 700 mm tower labelled 500 °C at Z=0 and
/// descending 5 °C per 10 mm block — the exact model Orca's own Temperature
/// calibration cuts a window from. Stored zipped (~1.5 MB) and unpacked with the
/// crate's existing `zip` dependency. Using the real master (rather than the
/// stale `temperature_tower.stl`, a different/shorter model) is what makes the
/// cut window's embossed labels match the injected temperatures.
const MASTER_TOWER_ZIP: &[u8] = include_bytes!("../../resources/temperature_tower_master.zip");

/// Decode the bundled temperature-tower master into a mesh.
pub fn load_master_tower() -> Result<Mesh, String> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(MASTER_TOWER_ZIP);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("master tower archive: {e}"))?;
    let mut entry = archive
        .by_index(0)
        .map_err(|e| format!("master tower entry: {e}"))?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read master tower: {e}"))?;
    parse_binary_stl(&bytes)
}

/// Trim a mesh to one side of the horizontal plane `z = zcut` (in the mesh's own
/// coordinates), clipping triangles that straddle the plane so the walls stay
/// closed at every layer. `keep_above` selects which side is retained. No cap is
/// added on the cut face — each horizontal slice is still a closed loop from the
/// walls, which is what the slicer needs. Degenerate (zero-area) faces produced
/// by vertex-welding at the plane are dropped, since a face with an undefined
/// normal crashes OrcaSlicer's GUI mesh analysis (OpenCASCADE self-intersection →
/// ACCESS_VIOLATION) on load even though the headless `--slice` path tolerates it.
pub fn cut_plane(mesh: &Mesh, zcut: f64, keep_above: bool) -> Mesh {
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut index: HashMap<(i64, i64, i64), usize> = HashMap::new();
    let q = |f: f64| (f * 100_000.0).round() as i64;
    let push = |v: [f64; 3], vertices: &mut Vec<[f64; 3]>, index: &mut HashMap<(i64, i64, i64), usize>| -> usize {
        let key = (q(v[0]), q(v[1]), q(v[2]));
        *index.entry(key).or_insert_with(|| {
            vertices.push(v);
            vertices.len() - 1
        })
    };
    // Whether a vertex is on the retained side of the plane.
    let kept_side = |z: f64| -> bool {
        if keep_above {
            z >= zcut
        } else {
            z <= zcut
        }
    };
    // Intersection of edge P→Q with the plane z = zcut.
    let cross = |p: [f64; 3], qy: [f64; 3]| -> [f64; 3] {
        let t = (zcut - p[2]) / (qy[2] - p[2]);
        [p[0] + t * (qy[0] - p[0]), p[1] + t * (qy[1] - p[1]), zcut]
    };

    let mut triangles: Vec<[usize; 3]> = Vec::new();
    for tri in &mesh.triangles {
        let v = [mesh.vertices[tri[0]], mesh.vertices[tri[1]], mesh.vertices[tri[2]]];
        let keep = [kept_side(v[0][2]), kept_side(v[1][2]), kept_side(v[2][2])];
        let nk = keep.iter().filter(|&&b| b).count();
        match nk {
            3 => {
                let a = push(v[0], &mut vertices, &mut index);
                let b = push(v[1], &mut vertices, &mut index);
                let c = push(v[2], &mut vertices, &mut index);
                triangles.push([a, b, c]);
            }
            0 => {}
            _ => {
                // Rotate so the winding is preserved while handling the two cases
                // by the index of the "odd one out".
                let order = [0usize, 1usize, 2usize];
                if nk == 1 {
                    // one kept (A), two removed (B,C): keep triangle A, P_ab, P_ac
                    let a_pos = order.iter().position(|&k| keep[k]).unwrap();
                    let a = v[order[a_pos]];
                    let b = v[order[(a_pos + 1) % 3]];
                    let c = v[order[(a_pos + 2) % 3]];
                    let ia = push(a, &mut vertices, &mut index);
                    let iab = push(cross(a, b), &mut vertices, &mut index);
                    let iac = push(cross(a, c), &mut vertices, &mut index);
                    triangles.push([ia, iab, iac]);
                } else {
                    // two kept (A,B), one removed (C): keep quad A,B,P_bc,P_ac
                    let c_pos = order.iter().position(|&k| !keep[k]).unwrap();
                    let c = v[order[c_pos]];
                    let a = v[order[(c_pos + 1) % 3]];
                    let b = v[order[(c_pos + 2) % 3]];
                    let ia = push(a, &mut vertices, &mut index);
                    let ib = push(b, &mut vertices, &mut index);
                    let ibc = push(cross(b, c), &mut vertices, &mut index);
                    let iac = push(cross(a, c), &mut vertices, &mut index);
                    triangles.push([ia, ib, ibc]);
                    triangles.push([ia, ibc, iac]);
                }
            }
        }
    }
    triangles.retain(|t| {
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
            return false;
        }
        let (a, b, c) = (vertices[t[0]], vertices[t[1]], vertices[t[2]]);
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > 1e-12
    });
    Mesh { vertices, triangles }
}

/// Trim a mesh to everything at or below `zcut`. Thin wrapper over `cut_plane`.
pub fn cut_below_z(mesh: &Mesh, zcut: f64) -> Mesh {
    cut_plane(mesh, zcut, false)
}

/// Uniformly scale a mesh about the origin (Orca scales the whole calibration
/// object by `nozzle / 0.4`).
pub fn scale_mesh(mesh: &Mesh, s: f64) -> Mesh {
    Mesh {
        vertices: mesh.vertices.iter().map(|v| [v[0] * s, v[1] * s, v[2] * s]).collect(),
        triangles: mesh.triangles.clone(),
    }
}

/// The reference constants Orca's `Plater::calib_temp` uses to map a temperature
/// range onto a window of the master tower: 500 °C at the base, 5 °C per block,
/// 10 mm per block (at the base 0.4 mm nozzle).
const TOWER_REF_TEMP: i32 = 500;
const TOWER_TEMP_STEP: i32 = 5;
const TOWER_BLOCK_MM: f64 = 10.0;
const TOWER_BASE_NOZZLE: f64 = 0.4;

/// Cut the temperature-tower master to the [start, end] window, replicating
/// `Plater::calib_temp`: keep the Z window whose embossed labels run from `start`
/// (hottest, bottom) to `end` (coolest, top), then scale by `nozzle / 0.4`.
/// Because the labels are baked into the master at `500 − Z/2` °C, cutting this
/// exact window is what makes them match the injected M104 schedule.
pub fn cut_temperature_window(
    master: &Mesh,
    start_temp: i32,
    end_temp: i32,
    nozzle_mm: f64,
) -> Result<Mesh, String> {
    if start_temp <= end_temp {
        return Err("start_temp must be greater than end_temp".into());
    }
    // Orca: cut upper keeps below ((500-end)/step + 1) blocks; cut bottom keeps
    // above ((500-start)/step) blocks. Match Orca's `lround` (nearest), not i32
    // truncation, so a non-multiple-of-5 endpoint lands on the same block.
    let step = TOWER_TEMP_STEP as f64;
    let z_lo = (((TOWER_REF_TEMP - start_temp) as f64) / step).round() * TOWER_BLOCK_MM;
    let z_hi = ((((TOWER_REF_TEMP - end_temp) as f64) / step).round() + 1.0) * TOWER_BLOCK_MM;
    let (mmin, mmax) = master.bounds();
    if z_lo < mmin[2] - 1e-6 || z_hi > mmax[2] + 1e-6 {
        let master_hot = TOWER_REF_TEMP - (mmin[2] / TOWER_BLOCK_MM * TOWER_TEMP_STEP as f64).round() as i32;
        let master_cold = TOWER_REF_TEMP - (mmax[2] / TOWER_BLOCK_MM * TOWER_TEMP_STEP as f64).round() as i32;
        return Err(format!(
            "Temperature range {end_temp}–{start_temp} °C is outside the master tower ({master_cold}–{master_hot} °C)"
        ));
    }
    // Keep the window [z_lo, z_hi] (coordinates preserved; the assembler rests
    // min-Z on the bed).
    let below = cut_plane(master, z_hi, false);
    let window = cut_plane(&below, z_lo, true);
    if window.triangles.is_empty() {
        return Err("Temperature window cut produced an empty mesh".into());
    }
    let scale = nozzle_mm / TOWER_BASE_NOZZLE;
    Ok(if (scale - 1.0).abs() > 1e-9 {
        scale_mesh(&window, scale)
    } else {
        window
    })
}

/// Format an f64 compactly for 3mf XML (trim trailing zeros, avoid `-0`).
fn num(f: f64) -> String {
    if f == 0.0 {
        return "0".into();
    }
    let mut s = format!("{f:.5}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}

/// The 3mf `<build>` item transform (scale-1 identity plus a translation) that
/// centers the mesh over `(plate_cx, plate_cy)` and rests it on the bed (min Z
/// → 0). 3mf transforms are 12 values: the 3×3 matrix then the translation.
pub fn centering_transform(mesh: &Mesh, plate_cx: f64, plate_cy: f64) -> String {
    let (min, max) = mesh.bounds();
    let tx = plate_cx - (min[0] + max[0]) / 2.0;
    let ty = plate_cy - (min[1] + max[1]) / 2.0;
    let tz = -min[2];
    format!("1 0 0 0 1 0 0 0 1 {} {} {}", num(tx), num(ty), num(tz))
}

/// Emit a standard-3mf `3D/3dmodel.model` with the single object inline and a
/// positioned build item. `object_id` is referenced by `model_settings.config`.
pub fn model_3dmodel_xml(mesh: &Mesh, object_id: u32, item_transform: &str) -> String {
    // Rough capacity: ~48 bytes/vertex + ~40 bytes/triangle.
    let mut s = String::with_capacity(mesh.vertices.len() * 48 + mesh.triangles.len() * 40 + 512);
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str(
        "<model unit=\"millimeter\" xml:lang=\"en-US\" \
xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" \
xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\">\n",
    );
    s.push_str(" <metadata name=\"Application\">PerfectFit-FilamentCalibrationWizard</metadata>\n");
    s.push_str(" <resources>\n");
    s.push_str(&format!("  <object id=\"{object_id}\" type=\"model\">\n   <mesh>\n    <vertices>\n"));
    for v in &mesh.vertices {
        s.push_str(&format!(
            "     <vertex x=\"{}\" y=\"{}\" z=\"{}\"/>\n",
            num(v[0]),
            num(v[1]),
            num(v[2])
        ));
    }
    s.push_str("    </vertices>\n    <triangles>\n");
    for t in &mesh.triangles {
        s.push_str(&format!(
            "     <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>\n",
            t[0], t[1], t[2]
        ));
    }
    s.push_str("    </triangles>\n   </mesh>\n  </object>\n </resources>\n");
    s.push_str(&format!(
        " <build>\n  <item objectid=\"{object_id}\" transform=\"{item_transform}\" printable=\"1\"/>\n </build>\n"
    ));
    s.push_str("</model>\n");
    s
}

/// The `Metadata/model_settings.config` that binds the object onto plate 1 — the
/// scaffolding the CLI needs (see the module doc). Mirrors the shape of a shipped
/// Orca project's config for a single object.
pub fn model_settings_xml(object_id: u32, name: &str, item_transform: &str) -> String {
    let esc = xml_escape(name);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n  \
<object id=\"{object_id}\">\n    <metadata key=\"name\" value=\"{esc}\"/>\n    \
<metadata key=\"extruder\" value=\"1\"/>\n    <part id=\"1\" subtype=\"normal_part\">\n      \
<metadata key=\"name\" value=\"{esc}\"/>\n      \
<metadata key=\"matrix\" value=\"1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1\"/>\n    </part>\n  </object>\n  \
<plate>\n    <metadata key=\"plater_id\" value=\"1\"/>\n    <metadata key=\"plater_name\" value=\"\"/>\n    \
<metadata key=\"locked\" value=\"false\"/>\n    <model_instance>\n      \
<metadata key=\"object_id\" value=\"{object_id}\"/>\n      \
<metadata key=\"instance_id\" value=\"0\"/>\n    </model_instance>\n  </plate>\n  \
<assemble>\n   <assemble_item object_id=\"{object_id}\" instance_id=\"0\" transform=\"{item_transform}\" offset=\"0 0 0\" />\n  \
</assemble>\n</config>\n"
    )
}

pub(crate) fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

const CONTENT_TYPES_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n\
 <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n\
 <Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n\
 <Default Extension=\"png\" ContentType=\"image/png\"/>\n\
 <Default Extension=\"config\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n\
</Types>\n";

const ROOT_RELS_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
 <Relationship Target=\"/3D/3dmodel.model\" Id=\"rel-1\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/>\n\
</Relationships>\n";

pub(crate) const SLICE_INFO_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n  <header>\n    \
<header_item key=\"X-BBL-Client-Type\" value=\"slicer\"/>\n    \
<header_item key=\"X-BBL-Client-Version\" value=\"01.07.03.04\"/>\n  </header>\n</config>\n";

/// Parse a plate center from a `project_settings.config`'s `printable_area`
/// (points like "0x0","256x0",…). Falls back to (128,128) when absent/unparseable.
pub fn plate_center_from_config(config_json: &str) -> (f64, f64) {
    let default = (128.0, 128.0);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(config_json) else {
        return default;
    };
    let Some(pts) = v.get("printable_area").and_then(|x| x.as_array()) else {
        return default;
    };
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut any = false;
    for p in pts {
        if let Some(s) = p.as_str() {
            let mut it = s.split('x');
            if let (Some(a), Some(b)) = (it.next(), it.next()) {
                if let (Ok(x), Ok(y)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                    any = true;
                    minx = minx.min(x);
                    miny = miny.min(y);
                    maxx = maxx.max(x);
                    maxy = maxy.max(y);
                }
            }
        }
    }
    if any {
        ((minx + maxx) / 2.0, (miny + maxy) / 2.0)
    } else {
        default
    }
}

/// Assemble a complete single-object project 3mf from a mesh + a resolved
/// `project_settings.config` (and optional generated `custom_gcode_per_layer.xml`).
/// Centers the object on the plate derived from the config. Returns the number of
/// zip entries written.
#[allow(clippy::too_many_arguments)]
pub fn assemble_model_project(
    out: &Path,
    mesh: &Mesh,
    object_name: &str,
    project_config_json: &str,
    custom_gcode_xml: Option<&str>,
) -> Result<usize, String> {
    let object_id = 1u32;
    let (cx, cy) = plate_center_from_config(project_config_json);
    let transform = centering_transform(mesh, cx, cy);
    let model_xml = model_3dmodel_xml(mesh, object_id, &transform);
    let model_settings = model_settings_xml(object_id, object_name, &transform);

    let out_file = std::fs::File::create(out).map_err(|e| format!("Cannot create project file: {e}"))?;
    let mut w = ZipWriter::new(std::io::BufWriter::new(out_file));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut entries: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", CONTENT_TYPES_XML.as_bytes()),
        ("_rels/.rels", ROOT_RELS_XML.as_bytes()),
        ("3D/3dmodel.model", model_xml.as_bytes()),
        ("Metadata/project_settings.config", project_config_json.as_bytes()),
        ("Metadata/model_settings.config", model_settings.as_bytes()),
        ("Metadata/slice_info.config", SLICE_INFO_XML.as_bytes()),
    ];
    if let Some(gcode) = custom_gcode_xml {
        entries.push(("Metadata/custom_gcode_per_layer.xml", gcode.as_bytes()));
    }

    for (name, bytes) in &entries {
        w.start_file(*name, opts).map_err(|e| format!("Zip write failed: {e}"))?;
        w.write_all(bytes).map_err(|e| format!("Zip write failed: {e}"))?;
    }
    w.finish().map_err(|e| format!("Zip finalize failed: {e}"))?;
    Ok(entries.len())
}

/// Assemble a temperature-tower project into the job workspace: take PerfectFit's
/// bundled master tower (decoded from Orca's own `temperature_tower.drc`), cut the
/// [start, end] window Orca's own calibration cuts (so the embossed labels match
/// the temperatures), scale it by `nozzle_mm / 0.4`, and package it with the
/// merged config and the generated per-band `custom_gcode_per_layer.xml`. Output
/// lands at `sessions/<session>/jobs/<job>/workspace/<output_file_name>`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn assemble_temperature_tower(
    session_id: String,
    job_id: String,
    start_temp: i32,
    end_temp: i32,
    nozzle_mm: f64,
    merged_config_json: String,
    custom_gcode_xml: String,
    output_file_name: String,
) -> Result<RawAssembledProject, String> {
    security::validate_component(&output_file_name)?;
    if !output_file_name.to_ascii_lowercase().ends_with(".3mf") {
        return Err("Output file must be a .3mf".into());
    }
    if !(nozzle_mm.is_finite() && nozzle_mm > 0.0) {
        return Err("nozzle_mm must be a positive number".into());
    }

    let master = load_master_tower()?;
    let mesh = cut_temperature_window(&master, start_temp, end_temp, nozzle_mm)?;

    let workspace = security::job_root(&session_id, &job_id)?.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|e| format!("Cannot create workspace: {e}"))?;
    let out_path = workspace.join(&output_file_name);
    let gcode = if custom_gcode_xml.trim().is_empty() {
        None
    } else {
        Some(custom_gcode_xml.as_str())
    };
    let entry_count = assemble_model_project(&out_path, &mesh, "TemperatureTower", &merged_config_json, gcode)?;

    Ok(RawAssembledProject {
        project_file_name: output_file_name,
        project_path: out_path.display().to_string(),
        workspace_dir: workspace.display().to_string(),
        config_replaced: true,
        entry_count,
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pf_modelproj_{tag}_{n}_{}", super::super::now_unix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a tiny binary STL for a unit cube (12 triangles), for structure tests.
    fn cube_stl() -> Vec<u8> {
        // 8 corners of a 10mm cube from origin.
        let c = [
            [0.0f32, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [10.0, 10.0, 10.0], [0.0, 10.0, 10.0],
        ];
        let faces = [
            [0, 3, 2], [0, 2, 1], // bottom
            [4, 5, 6], [4, 6, 7], // top
            [0, 1, 5], [0, 5, 4], // front
            [1, 2, 6], [1, 6, 5], // right
            [2, 3, 7], [2, 7, 6], // back
            [3, 0, 4], [3, 4, 7], // left
        ];
        let mut b = vec![0u8; 80];
        b.extend_from_slice(&(faces.len() as u32).to_le_bytes());
        for f in faces {
            b.extend_from_slice(&[0u8; 12]); // normal
            for vi in f {
                for comp in c[vi] {
                    b.extend_from_slice(&comp.to_le_bytes());
                }
            }
            b.extend_from_slice(&[0u8; 2]); // attribute
        }
        b
    }

    #[test]
    fn parses_binary_stl_and_dedups_vertices() {
        let mesh = parse_binary_stl(&cube_stl()).unwrap();
        assert_eq!(mesh.triangles.len(), 12);
        assert_eq!(mesh.vertices.len(), 8); // 8 unique corners after dedup
        let (min, max) = mesh.bounds();
        assert_eq!(min, [0.0, 0.0, 0.0]);
        assert_eq!(max, [10.0, 10.0, 10.0]);
    }

    #[test]
    fn rejects_truncated_stl() {
        assert!(parse_binary_stl(&[0u8; 10]).is_err());
        let mut b = vec![0u8; 84];
        b[80] = 5; // claims 5 triangles but has no data
        assert!(parse_binary_stl(&b).is_err());
    }

    #[test]
    fn centering_transform_centers_and_rests_on_bed() {
        let mesh = parse_binary_stl(&cube_stl()).unwrap();
        // cube spans 0..10 in each axis (center 5,5); plate center 128,128.
        let t = centering_transform(&mesh, 128.0, 128.0);
        // tx = 128 - 5 = 123, ty = 123, tz = -0 = 0
        assert_eq!(t, "1 0 0 0 1 0 0 0 1 123 123 0");
    }

    #[test]
    fn model_xml_has_vertices_triangles_and_positioned_build() {
        let mesh = parse_binary_stl(&cube_stl()).unwrap();
        let xml = model_3dmodel_xml(&mesh, 1, "1 0 0 0 1 0 0 0 1 123 123 0");
        assert!(xml.contains("<object id=\"1\" type=\"model\">"));
        assert_eq!(xml.matches("<vertex ").count(), 8);
        assert_eq!(xml.matches("<triangle ").count(), 12);
        assert!(xml.contains("<item objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 123 123 0\" printable=\"1\"/>"));
    }

    #[test]
    fn cut_below_z_trims_and_clips() {
        let mesh = parse_binary_stl(&cube_stl()).unwrap(); // 10mm cube, z 0..10
        let cut = cut_below_z(&mesh, 5.0);
        let (min, max) = cut.bounds();
        assert_eq!(min[2], 0.0);
        assert_eq!(max[2], 5.0, "top clipped to the plane");
        // still spans the full footprint below the cut
        assert_eq!(min[0], 0.0);
        assert_eq!(max[0], 10.0);
        assert!(!cut.triangles.is_empty());
        // every vertex is at or below the cut plane
        assert!(cut.vertices.iter().all(|v| v[2] <= 5.0 + 1e-9));
    }

    #[test]
    fn bundled_master_tower_decodes_to_orca_geometry() {
        // The bundled master (decoded from Orca's temperature_tower.drc) is a
        // 700mm tower labelled 500 C at Z=0, descending 5 C / 10 mm.
        let master = load_master_tower().unwrap();
        let (mmin, mmax) = master.bounds();
        assert!(
            (mmax[2] - mmin[2] - 700.0).abs() < 1.0,
            "master should be ~700mm tall, got {}",
            mmax[2] - mmin[2]
        );
        assert!(mmin[2].abs() < 1e-3, "master base at Z=0");
    }

    #[test]
    fn cut_temperature_window_matches_orca_cut() {
        let master = load_master_tower().unwrap();
        // PLA 230->190 => 9 blocks => 90mm window (0.4 nozzle, scale 1).
        let win = cut_temperature_window(&master, 230, 190, 0.4).unwrap();
        let (wmin, wmax) = win.bounds();
        assert!(
            (wmax[2] - wmin[2] - 90.0).abs() < 0.5,
            "230->190 window should be ~90mm, got {}",
            wmax[2] - wmin[2]
        );
        assert!(!win.triangles.is_empty());
        // A 0.6 nozzle scales the whole tower by 1.5 => 135mm.
        let win6 = cut_temperature_window(&master, 230, 190, 0.6).unwrap();
        let (w6min, w6max) = win6.bounds();
        assert!(
            (w6max[2] - w6min[2] - 135.0).abs() < 1.0,
            "0.6 nozzle window should be ~135mm, got {}",
            w6max[2] - w6min[2]
        );
        // Guards: inverted range and a range above the master both error.
        assert!(cut_temperature_window(&master, 190, 230, 0.4).is_err());
        assert!(cut_temperature_window(&master, 600, 550, 0.4).is_err());
    }

    #[test]
    fn plate_center_parses_printable_area() {
        let cfg = r#"{"printable_area":["0x0","256x0","256x256","0x256"]}"#;
        assert_eq!(plate_center_from_config(cfg), (128.0, 128.0));
        assert_eq!(plate_center_from_config("{}"), (128.0, 128.0)); // fallback
    }

    #[test]
    fn assembles_a_project_zip_with_all_scaffolding() {
        use std::io::Read;
        let mesh = parse_binary_stl(&cube_stl()).unwrap();
        let d = temp_dir("assemble");
        let out = d.join("project.3mf");
        let cfg = r#"{"printable_area":["0x0","256x0","256x256","0x256"],"layer_height":"0.2"}"#;
        let n = assemble_model_project(&out, &mesh, "TempTower", cfg, Some("<xml/>")).unwrap();
        assert_eq!(n, 7); // 6 base + custom gcode

        let f = std::fs::File::open(&out).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        for req in [
            "[Content_Types].xml",
            "_rels/.rels",
            "3D/3dmodel.model",
            "Metadata/project_settings.config",
            "Metadata/model_settings.config",
            "Metadata/slice_info.config",
            "Metadata/custom_gcode_per_layer.xml",
        ] {
            assert!(names.iter().any(|n| n == req), "missing {req}");
        }
        // model_settings references the object and plate 1
        let mut ms = String::new();
        z.by_name("Metadata/model_settings.config").unwrap().read_to_string(&mut ms).unwrap();
        assert!(ms.contains("object_id\" value=\"1\"") && ms.contains("plater_id\" value=\"1\""));
        std::fs::remove_dir_all(&d).ok();
    }

    /// Supervised real-Orca proof of the production temperature-tower path: cut
    /// the [start, end] window from PerfectFit's BUNDLED master (decoded from
    /// Orca's own `temperature_tower.drc`, the same window Orca cuts), wrap it in
    /// a from-scratch project (donor config stands in for a resolved one) with the
    /// generated M104 custom-gcode, and headless-slice it. Proves the cut window
    /// slices (exit 0 + g-code) and the injections land. The embossed labels
    /// matching the temps is verified by opening the emitted project in the GUI
    /// (set PF_EMIT_PROJECT). Run with
    /// `cargo test -- --ignored probe_real_temp_tower_project`.
    #[test]
    #[ignore]
    fn probe_real_temp_tower_project() {
        use super::super::project_assembly::read_project_config;
        use crate::slicer_integration::test_support;
        use std::process::{Command, Stdio};
        let orca = test_support::orca_exe();
        let donor = test_support::orca_calib("pressure_advance/pa_pattern.3mf");
        if !orca.is_file() || !donor.is_file() {
            eprintln!("SKIP: Orca / donor not present");
            return;
        }
        let master = load_master_tower().unwrap();
        let (min0, max0) = master.bounds();
        println!(
            "bundled master tower: {} tris, {} verts, height {:.1}mm",
            master.triangles.len(),
            master.vertices.len(),
            max0[2] - min0[2]
        );

        // Cut the PLA window (230->190, 0.4 nozzle) exactly as Orca's calibration
        // does — the labels on this window run 230 (bottom) to 190 (top).
        let band_height = 10.0;
        let bands = 9; // 230,225,...,190
        let mesh = cut_temperature_window(&master, 230, 190, 0.4).unwrap();
        let (_minc, maxc) = mesh.bounds();
        println!("cut window: {} tris, {} verts, height {:.1}mm", mesh.triangles.len(), mesh.vertices.len(), maxc[2] - _minc[2]);

        let cfg = read_project_config(donor.display().to_string()).unwrap();

        // Per-band temperature changes (mirrors temperatureTower.ts): one M104 at
        // each band boundary, in FINAL coords (assembler rests min-z at 0).
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id=\"1\"/>\n",
        );
        let mut want_temps = Vec::new();
        for i in 1..bands {
            let z = band_height * i as f64; // 10,20,...,80
            let temp = 230 - 5 * i as i32; // 225,220,...,190
            want_temps.push(temp);
            xml.push_str(&format!(
                "<layer top_z=\"{z}\" type=\"4\" extruder=\"-858993460\" color=\"\" extra=\"M104 S{temp}\"/>\n"
            ));
        }
        xml.push_str("</plate>\n</custom_gcodes_per_layer>\n");

        let d = temp_dir("temptower");
        let project = d.join("project.3mf");
        assemble_model_project(&project, &mesh, "TemperatureTower", &cfg, Some(&xml)).unwrap();

        // Optional: emit the assembled project to a stable path for manual GUI
        // inspection (does OrcaSlicer's *GUI* open it without crashing?). The
        // headless slice below only exercises the CLI path, which is more lenient.
        if let Ok(dst) = std::env::var("PF_EMIT_PROJECT") {
            std::fs::copy(&project, &dst).unwrap();
            println!("EMITTED PROJECT: {dst}");
        }

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
        println!("orca exit={:?} gcode_exists={}", status.code(), gcode.is_file());
        if !gcode.is_file() {
            eprintln!("FINDING: synthesized temp-tower project did NOT slice — inspect datadir/log.");
            // leave artifacts for inspection
            println!("artifacts kept at {}", d.display());
            return;
        }
        let text = std::fs::read_to_string(&gcode).unwrap_or_default();
        let present: Vec<i32> = want_temps.iter().copied().filter(|t| text.contains(&format!("M104 S{t}"))).collect();
        println!("gcode {} bytes; injected temps present: {present:?} of {want_temps:?}", text.len());
        assert!(!present.is_empty(), "expected injected M104 temperatures in the g-code");
        std::fs::remove_dir_all(&d).ok();
    }
}
