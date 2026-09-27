// ---------------------------------------------------------------------------
// Server bridge: the single boundary between store.ts and the optional
// self-hosted HTTP backend (server/, phase 1). Mirrors the shape of
// slicerIntegration/bridge.ts — everything downstream degrades cleanly to
// the IndexedDB/localStorage path when no backend is reachable.
//
// Request paths are relative (`./api/v1/...`) by default, which works when
// this page is served BY the same server (subpath/static host, per
// vite.config.ts's `base: './'` contract). That assumption breaks for a
// client that isn't same-origin with the server — chiefly the Tauri desktop
// build, which loads its assets from tauri://, not from the Docker host. A
// persisted, optional server URL (below) switches request building to
// absolute URLs instead; unset, behavior is byte-for-byte what it was
// before phase 6.
// ---------------------------------------------------------------------------

import type { AppSettings, CalibrationId, CalibrationProject, PrinterProfile, StoredPhoto } from '../types';

const API_BASE = './api/v1';
const TOKEN_KEY = 'perfectfit.apiToken';
const SERVER_URL_KEY = 'perfectfit.serverUrl';

// --- backend detection -------------------------------------------------------

let backendReadyPromise: Promise<boolean> | null = null;
/** Synchronous snapshot of the last resolved detection result — false until backendReady() resolves once. */
let backendReadyValue = false;

/** Forces the next backendReady() call to re-probe rather than return a cached result — needed after the server URL changes, since that changes what "reachable" even means. */
function resetBackendDetection(): void {
  backendReadyPromise = null;
  backendReadyValue = false;
}

async function detectBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Probes for a live backend once per page load (or since the last URL/reset change) and memoizes the result. */
export function backendReady(): Promise<boolean> {
  if (!backendReadyPromise) {
    backendReadyPromise = detectBackend().then((ready) => {
      backendReadyValue = ready;
      return ready;
    });
  }
  return backendReadyPromise;
}

/**
 * Synchronous read of the already-resolved backend-detection result, for callers
 * (like store.ts's synchronous saveSettings) that must not block on a fresh probe.
 * Always false until backendReady() has resolved at least once.
 */
export function isBackendReadySync(): boolean {
  return backendReadyValue;
}

// --- token storage ----------------------------------------------------------
// Shared with main.ts's ?token= capture-and-strip flow and the Settings
// "Server connection" card, so both go through one key/accessor set.

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// --- server URL storage -------------------------------------------------------
// Same accessor shape as the token above, for symmetry in callers (main.ts,
// Settings). Unset (the default) means "use this page's own address" —
// existing same-origin browser deployments never need to touch this.

export function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getStoredServerUrl(): string | null {
  return localStorage.getItem(SERVER_URL_KEY);
}

/** Throws if `url` doesn't parse as an http(s) URL — rejects e.g. `javascript:` before it ever reaches localStorage or fetch(). */
export function setStoredServerUrl(url: string): void {
  const trimmed = url.trim();
  if (!isValidServerUrl(trimmed)) {
    throw new Error('Server URL must start with http:// or https://');
  }
  localStorage.setItem(SERVER_URL_KEY, trimmed);
  resetBackendDetection();
}

export function clearStoredServerUrl(): void {
  localStorage.removeItem(SERVER_URL_KEY);
  resetBackendDetection();
}

function apiBase(): string {
  const url = getStoredServerUrl();
  return url ? `${url.replace(/\/$/, '')}/api/v1` : API_BASE;
}

/**
 * True when running somewhere a relative fetch structurally cannot reach a
 * same-origin server (currently: the Tauri desktop shell, which serves its
 * assets from tauri://). Duplicated rather than imported from
 * slicerIntegration/bridge.ts's isDesktop(): that check dereferences
 * `window` unconditionally, which throws under this project's bare-Node
 * vitest environment (no jsdom) — store.ts and this module are exercised
 * there directly, and storage/ shouldn't need to pull in the
 * slicerIntegration bounded context just for an environment guard.
 */
export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

// --- fetch helpers ------------------------------------------------------------

/** Thrown by the request helpers below instead of a plain Error, so callers (namely connectionState detection) can tell a 401 apart from other failures. */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function authHeaders(): HeadersInit {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) }
  });
}

async function getJson<T>(path: string): Promise<T | undefined> {
  const res = await apiFetch(path);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ApiError(`GET ${path} failed: ${res.status}`, res.status);
  return (await res.json()) as T;
}

async function listJson<T>(path: string): Promise<T[]> {
  const res = await apiFetch(path);
  if (!res.ok) throw new ApiError(`GET ${path} failed: ${res.status}`, res.status);
  return (await res.json()) as T[];
}

async function putJson(path: string, body: unknown): Promise<void> {
  const res = await apiFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new ApiError(`PUT ${path} failed: ${res.status}`, res.status);
}

async function del(path: string): Promise<void> {
  const res = await apiFetch(path, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(`DELETE ${path} failed: ${res.status}`, res.status);
}

// --- photo wire helpers ---------------------------------------------------

type PhotoMeta = Omit<StoredPhoto, 'blob'>;

function photoQuery(photo: PhotoMeta): string {
  const params = new URLSearchParams({
    projectId: photo.projectId,
    stepId: photo.stepId,
    attemptId: photo.attemptId,
    createdAt: photo.createdAt,
    name: photo.name,
    type: photo.type
  });
  return params.toString();
}

async function putPhotoHttp(photo: StoredPhoto): Promise<void> {
  const res = await apiFetch(`/photos/${encodeURIComponent(photo.id)}?${photoQuery(photo)}`, {
    method: 'PUT',
    body: photo.blob
  });
  if (!res.ok) throw new Error(`PUT /photos/${photo.id} failed: ${res.status}`);
}

async function fetchPhotosForProject(projectId: string): Promise<StoredPhoto[]> {
  const metaList = await listJson<PhotoMeta>(`/projects/${encodeURIComponent(projectId)}/photos`);
  const photos: StoredPhoto[] = [];
  for (const meta of metaList) {
    const res = await apiFetch(`/photos/${encodeURIComponent(meta.id)}`);
    if (!res.ok) throw new Error(`GET /photos/${meta.id} failed: ${res.status}`);
    const blob = await res.blob();
    // FORGE-NOTE: server stores stepId as an opaque string in the photos table
    // (it never validates against CalibrationId); cast trusts the same data the
    // app itself wrote via putPhotoHttp below.
    photos.push({ ...meta, stepId: meta.stepId as CalibrationId, blob });
  }
  return photos;
}

/**
 * Phase 1's server has no "list every photo across every project" endpoint
 * (only per-project), and server/ is already-shipped, already-PR'd work —
 * adding a route there for this would mean reopening that PR for a single
 * export-time convenience call. Composing it from listProjects +
 * getPhotosForProject instead costs one extra round-trip per project, which
 * is fine for a single-user, modest-data-volume tool.
 */
async function fetchAllPhotos(): Promise<StoredPhoto[]> {
  const projects = await listJson<CalibrationProject>('/projects');
  const perProject = await Promise.all(projects.map((p) => fetchPhotosForProject(p.id)));
  return perProject.flat();
}

// --- public HTTP-backed implementations of the store.ts API -----------------

export const http = {
  listPrinters: (): Promise<PrinterProfile[]> => listJson<PrinterProfile>('/printers'),
  getPrinter: (id: string): Promise<PrinterProfile | undefined> =>
    getJson<PrinterProfile>(`/printers/${encodeURIComponent(id)}`),
  savePrinter: (p: PrinterProfile): Promise<void> => putJson(`/printers/${encodeURIComponent(p.id)}`, p),
  deletePrinter: (id: string): Promise<void> => del(`/printers/${encodeURIComponent(id)}`),

  listProjects: (): Promise<CalibrationProject[]> => listJson<CalibrationProject>('/projects'),
  getProject: (id: string): Promise<CalibrationProject | undefined> =>
    getJson<CalibrationProject>(`/projects/${encodeURIComponent(id)}`),
  saveProject: (p: CalibrationProject): Promise<void> => putJson(`/projects/${encodeURIComponent(p.id)}`, p),
  deleteProject: (id: string): Promise<void> => del(`/projects/${encodeURIComponent(id)}`),

  savePhoto: (photo: StoredPhoto): Promise<void> => putPhotoHttp(photo),
  getPhotosForProject: (projectId: string): Promise<StoredPhoto[]> => fetchPhotosForProject(projectId),
  listAllPhotos: (): Promise<StoredPhoto[]> => fetchAllPhotos(),
  deletePhoto: (id: string): Promise<void> => del(`/photos/${encodeURIComponent(id)}`),

  getSettings: (): Promise<AppSettings | null> => apiFetch('/settings').then(async (res) => {
    if (!res.ok) throw new ApiError(`GET /settings failed: ${res.status}`, res.status);
    return (await res.json()) as AppSettings | null;
  }),
  putSettings: (s: AppSettings): Promise<void> => putJson('/settings', s),

  bulkErase: (): Promise<void> => del('/data')
};
