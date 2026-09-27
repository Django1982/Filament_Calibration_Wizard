import type { BackupFile, CalibrationProject, PrinterProfile } from '../types';
import { SCHEMA_VERSION, ensureProjectSteps, listAllPhotos, listPrinters, listProjects, loadSettings, saveProject, savePhoto, savePrinter, uid } from '../storage/store';

/** Serialize one project (with its printer profile embedded) for sharing. */
export async function exportProject(p: CalibrationProject, printer?: PrinterProfile): Promise<string> {
  const file: BackupFile = {
    app: 'perfectfit-filament-calibration-wizard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    projects: [p],
    printers: printer ? [printer] : []
  };
  return JSON.stringify(file, null, 2);
}

export async function exportAll(includePhotos: boolean): Promise<string> {
  const file: BackupFile = {
    app: 'perfectfit-filament-calibration-wizard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    projects: await listProjects(),
    printers: await listPrinters(),
    settings: loadSettings()
  };
  if (includePhotos) {
    const photos = await listAllPhotos();
    file.photos = await Promise.all(photos.map(async ph => ({
      meta: { id: ph.id, projectId: ph.projectId, stepId: ph.stepId, attemptId: ph.attemptId, createdAt: ph.createdAt, name: ph.name, type: ph.type },
      dataUrl: await blobToDataUrl(ph.blob)
    })));
  }
  return JSON.stringify(file, null, 2);
}

export interface ImportResult {
  ok: boolean;
  message: string;
  projectsImported: number;
  printersImported: number;
  photosImported: number;
}

/**
 * Import a backup or single-project file. Never overwrites existing records:
 * colliding ids get fresh ids (a copy is imported alongside the original).
 */
export async function importBackup(json: string): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: 'That file is not valid JSON.', projectsImported: 0, printersImported: 0, photosImported: 0 };
  }
  const file = parsed as Partial<BackupFile>;
  if (file.app !== 'perfectfit-filament-calibration-wizard' || !Array.isArray(file.projects)) {
    return { ok: false, message: 'That file doesn\'t look like a PerfectFit export (missing app marker or projects).', projectsImported: 0, printersImported: 0, photosImported: 0 };
  }
  if ((file.schemaVersion ?? 0) > SCHEMA_VERSION) {
    return { ok: false, message: `This file was made by a newer app version (schema ${file.schemaVersion} > ${SCHEMA_VERSION}). Update the app first.`, projectsImported: 0, printersImported: 0, photosImported: 0 };
  }

  const migrated = migrate(file as BackupFile);

  const existingPrinters = new Set((await listPrinters()).map(p => p.id));
  const existingProjects = new Set((await listProjects()).map(p => p.id));
  const printerIdMap = new Map<string, string>();
  let printersImported = 0, projectsImported = 0, photosImported = 0;

  for (const printer of migrated.printers ?? []) {
    if (!printer?.id || !printer.name) continue;
    let id = printer.id;
    if (existingPrinters.has(id)) {
      // Same id already present — assume it's the same profile; reference it, don't duplicate.
      printerIdMap.set(printer.id, id);
      continue;
    }
    printerIdMap.set(printer.id, id);
    await savePrinter({ ...printer, id });
    printersImported++;
  }

  const projectIdMap = new Map<string, string>();
  for (const project of migrated.projects) {
    if (!project?.id || !project.filament) continue;
    let id = project.id;
    if (existingProjects.has(id)) {
      id = uid();
      project.filament.productLine = project.filament.productLine || '';
    }
    projectIdMap.set(project.id, id);
    const mappedPrinter = printerIdMap.get(project.printerProfileId) ?? project.printerProfileId;
    await saveProject({ ...project, id, printerProfileId: mappedPrinter });
    projectsImported++;
  }

  for (const ph of migrated.photos ?? []) {
    try {
      const blob = dataUrlToBlob(ph.dataUrl);
      const projectId = projectIdMap.get(ph.meta.projectId) ?? ph.meta.projectId;
      await savePhoto({ ...ph.meta, id: uid(), projectId, blob });
      photosImported++;
    } catch { /* skip broken photo entries */ }
  }

  return {
    ok: true,
    message: `Imported ${projectsImported} project(s), ${printersImported} printer(s)${photosImported ? `, ${photosImported} photo(s)` : ''}.`,
    projectsImported, printersImported, photosImported
  };
}

/** Migrate older schema versions forward. v5 is current. */
export function migrate(file: BackupFile): BackupFile {
  const v = file.schemaVersion ?? 1;
  let out = file;
  if (v < 2) {
    // v1 → v2: generatedProfiles added; absent means none.
    out = { ...out, schemaVersion: 2 };
  }
  if ((out.schemaVersion ?? 1) < 3) {
    // v2 → v3: flow-verify + shrinkage steps added; ensureProjectSteps below
    // inserts them as not-started.
    out = { ...out, schemaVersion: 3 };
  }
  if ((out.schemaVersion ?? 1) < 4) {
    // v3 → v4: PrinterProfile gained optional extended specs + database link.
    // Additive — printers without the new keys are already valid. Mark
    // pre-v4 printers as manual so the UI doesn't imply a database match.
    for (const printer of out.printers ?? []) {
      if (printer.databasePrinterId === undefined && printer.isManual === undefined) {
        printer.isManual = true;
      }
    }
    out = { ...out, schemaVersion: 4 };
  }
  if ((out.schemaVersion ?? 1) < 5) {
    // v4 → v5: CalibrationProject gained optional automated-calibration session
    // fields. Additive — projects without them are already valid (no automated
    // session). The defensive normalization below tidies the arrays when the
    // fields are present. Nothing to transform otherwise.
    out = { ...out, schemaVersion: 5 };
  }
  // Defensive normalization regardless of version:
  for (const p of out.projects ?? []) {
    p.timeline = Array.isArray(p.timeline) ? p.timeline : [];
    p.finals = p.finals ?? {};
    p.archived = !!p.archived;
    p.generatedProfiles = Array.isArray(p.generatedProfiles) ? p.generatedProfiles : [];
    for (const key of Object.keys(p.steps ?? {})) {
      const st = (p.steps as Record<string, { history?: unknown[] }>)[key];
      if (st && !Array.isArray(st.history)) st.history = [];
    }
    // Automated session fields: only normalize when a session is present, so we
    // never fabricate a session on a plain manual project.
    if (p.sessionStatus !== undefined || p.workingProfile !== undefined) {
      p.generatedJobs = Array.isArray(p.generatedJobs) ? p.generatedJobs : [];
      p.sessionWarnings = Array.isArray(p.sessionWarnings) ? p.sessionWarnings : [];
    }
    ensureProjectSteps(p);
  }
  return out;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
