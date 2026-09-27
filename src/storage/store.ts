import type {
  AppSettings, CalibrationProject, CalibrationId, CalibrationStepState,
  PrinterProfile, StoredPhoto, TimelineEntry, ExperienceMode
} from '../types';
import { DEFAULT_ORDER } from '../data/calibrations';
import { idb } from './db';
import { ApiError, backendReady, getStoredServerUrl, http, isBackendReadySync, isDesktopRuntime } from './serverBridge';
import { deriveConnectionState, setConnectionState } from './connectionState';

/**
 * v1: original release.
 * v2: adds CalibrationProject.generatedProfiles (slicer profile installer).
 * v3: adds the flow-verify and shrinkage calibration steps (existing projects
 *     gain them as not-started via ensureProjectSteps) and finals.shrinkagePercent.
 * v4: adds optional extended machine specs + printer-database linkage to
 *     PrinterProfile (model, maxChamberTemp, heatedChamber, supportedNozzle-
 *     Diameters, buildVolume, maxPrintSpeed/Acceleration, firmware, extruder-
 *     Count, multiMaterialCompatibility, releaseYear, databasePrinterId,
 *     isManual). Purely additive — existing printers load unchanged.
 * v5: adds optional automated-calibration session fields to CalibrationProject
 *     (slicerMode, sessionStatus, workingProfile, generatedJobs, sessionWarnings,
 *     selectedEngineId, automatedSchemaVersion). Purely additive and gated behind
 *     the disabled `automatedCalibration` flag — existing projects load unchanged
 *     and IndexedDB persists the new optional fields with no store changes.
 */
export const SCHEMA_VERSION = 5;

// --- ids -------------------------------------------------------------------

export function uid(): string {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// --- settings (localStorage) ----------------------------------------------

const SETTINGS_KEY = 'perfectfit.settings';
const AUTOSAVE_KEY = 'perfectfit.autosave';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  largeText: false,
  defaultMode: 'coach',
  mvsSafetyMargin: 0.85
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  // Best-effort background sync — this function stays synchronous (6 call
  // sites depend on that), so a backend probe can't be awaited here. Only
  // fire if a backend was already confirmed present by an earlier
  // backendReady() resolution (see hydrateSettingsFromServer in main.ts).
  if (isBackendReadySync()) {
    void http.putSettings(s).catch((err) => console.warn('Failed to sync settings to server', err));
  }
}

/**
 * Pulls settings from the backend (if any) into localStorage before the app's
 * first synchronous loadSettings() call. Must be awaited once, early, at
 * startup (see main.ts) — a no-op when no backend is reachable. Also this is
 * where connectionState.ts's three-state detection is resolved: a 401 here
 * means a token is required and missing/wrong ('needs-token'), any other
 * outcome after a successful health check means 'connected' — the server IS
 * reachable, so an unrelated fetch hiccup shouldn't be reported as an auth
 * problem. Also re-run (from Settings) after the user saves a new token, to
 * re-check the connection without a full page reload.
 */
export async function hydrateSettingsFromServer(): Promise<void> {
  const isDesktop = isDesktopRuntime();
  const hasServerUrl = getStoredServerUrl() !== null;

  const ready = await backendReady();
  if (!ready) {
    setConnectionState(deriveConnectionState({ healthOk: false, authFailed: false, isDesktop, hasServerUrl }));
    return;
  }
  let authFailed = false;
  try {
    const serverSettings = await http.getSettings();
    if (serverSettings) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...serverSettings }));
    }
  } catch (err) {
    authFailed = err instanceof ApiError && err.status === 401;
    if (!authFailed) console.warn('Failed to hydrate settings from server', err);
  }
  setConnectionState(deriveConnectionState({ healthOk: true, authFailed, isDesktop, hasServerUrl }));
}

/** Auto-save of in-progress form data, keyed by project+step. */
export function saveDraft(key: string, data: unknown): void {
  try {
    const all = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) ?? '{}');
    all[key] = { at: new Date().toISOString(), data };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(all));
  } catch { /* quota errors are non-fatal for drafts */ }
}

export function loadDraft<T>(key: string): T | null {
  try {
    const all = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) ?? '{}');
    return all[key]?.data ?? null;
  } catch { return null; }
}

export function clearDraft(key: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) ?? '{}');
    delete all[key];
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

// --- printers --------------------------------------------------------------
// Each exported function dispatches to the HTTP backend when one is present
// (detected once via backendReady()), otherwise falls back to IndexedDB. No
// call site elsewhere in the app needs to know which store is in play.

async function idbListPrinters(): Promise<PrinterProfile[]> {
  const all = await idb.getAll<PrinterProfile>('printers');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

async function idbGetPrinter(id: string): Promise<PrinterProfile | undefined> {
  return idb.get<PrinterProfile>('printers', id);
}

async function idbSavePrinter(p: PrinterProfile): Promise<void> {
  await idb.put('printers', p);
}

async function idbDeletePrinter(id: string): Promise<void> {
  await idb.delete('printers', id);
}

export async function listPrinters(): Promise<PrinterProfile[]> {
  if (await backendReady()) return http.listPrinters();
  return idbListPrinters();
}

export async function getPrinter(id: string): Promise<PrinterProfile | undefined> {
  if (await backendReady()) return http.getPrinter(id);
  return idbGetPrinter(id);
}

export async function savePrinter(p: PrinterProfile): Promise<void> {
  p.updatedAt = new Date().toISOString();
  if (await backendReady()) return http.savePrinter(p);
  return idbSavePrinter(p);
}

export async function deletePrinter(id: string): Promise<void> {
  if (await backendReady()) return http.deletePrinter(id);
  return idbDeletePrinter(id);
}

// --- projects --------------------------------------------------------------

export function emptyStepState(): CalibrationStepState {
  return { status: 'not-started', current: null, history: [] };
}

export function newProjectSteps(): Record<CalibrationId, CalibrationStepState> {
  const steps = {} as Record<CalibrationId, CalibrationStepState>;
  for (const id of DEFAULT_ORDER) steps[id] = emptyStepState();
  return steps;
}

/**
 * Make sure a project contains every step of the current DEFAULT_ORDER.
 * Steps introduced after the project was created are inserted as not-started,
 * at their canonical position relative to steps the user already has —
 * respecting any reordering the user did. Mutates and returns the project.
 */
export function ensureProjectSteps(p: CalibrationProject): CalibrationProject {
  p.stepOrder = Array.isArray(p.stepOrder) ? p.stepOrder : [...DEFAULT_ORDER];
  p.steps = p.steps ?? ({} as CalibrationProject['steps']);
  DEFAULT_ORDER.forEach((id, defIdx) => {
    if (!p.steps[id]) p.steps[id] = emptyStepState();
    if (p.stepOrder.includes(id)) return;
    // Insert after the nearest preceding canonical step the project has.
    let insertAt = 0;
    for (let i = defIdx - 1; i >= 0; i--) {
      const prevPos = p.stepOrder.indexOf(DEFAULT_ORDER[i]);
      if (prevPos !== -1) { insertAt = prevPos + 1; break; }
    }
    p.stepOrder.splice(insertAt, 0, id);
  });
  return p;
}

async function idbListProjects(): Promise<CalibrationProject[]> {
  return idb.getAll<CalibrationProject>('projects');
}

async function idbGetProject(id: string): Promise<CalibrationProject | undefined> {
  return idb.get<CalibrationProject>('projects', id);
}

async function idbSaveProject(p: CalibrationProject): Promise<void> {
  await idb.put('projects', p);
}

async function idbDeleteProject(id: string): Promise<void> {
  await idb.delete('projects', id);
  const photos = await idb.getAllByIndex<StoredPhoto>('photos', 'byProject', id);
  for (const ph of photos) await idb.delete('photos', ph.id);
}

export async function listProjects(): Promise<CalibrationProject[]> {
  const all = (await backendReady()) ? await http.listProjects() : await idbListProjects();
  return all.map(ensureProjectSteps).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function getProject(id: string): Promise<CalibrationProject | undefined> {
  const p = (await backendReady()) ? await http.getProject(id) : await idbGetProject(id);
  return p ? ensureProjectSteps(p) : undefined;
}

export async function saveProject(p: CalibrationProject): Promise<void> {
  p.updatedAt = new Date().toISOString();
  if (await backendReady()) return http.saveProject(p);
  return idbSaveProject(p);
}

export async function deleteProject(id: string): Promise<void> {
  // The server cascade-deletes a project's photos itself (server/db.ts
  // deleteProjectCascade); the IndexedDB path has no such foreign key, so it
  // does the cascade manually.
  if (await backendReady()) return http.deleteProject(id);
  return idbDeleteProject(id);
}

export function addTimeline(p: CalibrationProject, entry: Omit<TimelineEntry, 'id' | 'at'>): void {
  p.timeline.push({ id: uid(), at: new Date().toISOString(), ...entry });
}

export function completionPercent(p: CalibrationProject): number {
  const total = p.stepOrder.length;
  const done = p.stepOrder.filter(id => p.steps[id]?.status === 'completed').length;
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

export function currentStage(p: CalibrationProject): CalibrationId | null {
  for (const id of p.stepOrder) {
    const st = p.steps[id]?.status;
    if (st !== 'completed' && st !== 'skipped') return id;
  }
  return null;
}

// --- photos ----------------------------------------------------------------

async function idbSavePhoto(photo: StoredPhoto): Promise<void> {
  await idb.put('photos', photo);
}

async function idbGetPhotosForProject(projectId: string): Promise<StoredPhoto[]> {
  return idb.getAllByIndex<StoredPhoto>('photos', 'byProject', projectId);
}

async function idbListAllPhotos(): Promise<StoredPhoto[]> {
  return idb.getAll<StoredPhoto>('photos');
}

async function idbDeletePhoto(id: string): Promise<void> {
  await idb.delete('photos', id);
}

export async function savePhoto(photo: StoredPhoto): Promise<void> {
  if (await backendReady()) return http.savePhoto(photo);
  return idbSavePhoto(photo);
}

export async function getPhotosForProject(projectId: string): Promise<StoredPhoto[]> {
  if (await backendReady()) return http.getPhotosForProject(projectId);
  return idbGetPhotosForProject(projectId);
}

/** Every photo across every project — used by exportAll's full-backup path. */
export async function listAllPhotos(): Promise<StoredPhoto[]> {
  if (await backendReady()) return http.listAllPhotos();
  return idbListAllPhotos();
}

export async function deletePhoto(id: string): Promise<void> {
  if (await backendReady()) return http.deletePhoto(id);
  return idbDeletePhoto(id);
}

// --- factory ---------------------------------------------------------------

export function createProject(partial: {
  filament: CalibrationProject['filament'];
  printerProfileId: string;
  nozzleType: string;
  slicer: CalibrationProject['slicer'];
  notes: string;
  mode: ExperienceMode;
}): CalibrationProject {
  const now = new Date().toISOString();
  const p: CalibrationProject = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    calibrationDate: now.slice(0, 10),
    filament: partial.filament,
    printerProfileId: partial.printerProfileId,
    nozzleType: partial.nozzleType,
    slicer: partial.slicer,
    notes: partial.notes,
    mode: partial.mode,
    stepOrder: [...DEFAULT_ORDER],
    steps: newProjectSteps(),
    timeline: [],
    archived: false,
    finals: {}
  };
  addTimeline(p, { stepId: 'project', kind: 'created', summary: `Project created for ${partial.filament.manufacturer} ${partial.filament.material}` });
  return p;
}
