// Unit tests for serverBridge.ts's translation logic, against a mocked fetch.
// Every test resets modules + localStorage so backendReady()'s module-level
// cache never leaks between cases.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, CalibrationProject, PrinterProfile, StoredPhoto } from '../../src/types';

const mem = new Map<string, string>();

function stubLocalStorage(): void {
  mem.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear()
  });
}

async function freshModule() {
  vi.resetModules();
  stubLocalStorage();
  return import('../../src/storage/serverBridge');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backendReady / detectBackend', () => {
  it('resolves true on a 2xx {ok:true} health response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { backendReady } = await freshModule();

    expect(await backendReady()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('./api/v1/health', expect.objectContaining({ signal: expect.anything() }));
  });

  it('resolves false on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    const { backendReady } = await freshModule();
    expect(await backendReady()).toBe(false);
  });

  it('resolves false when fetch rejects (network error / timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { backendReady } = await freshModule();
    expect(await backendReady()).toBe(false);
  });

  it('resolves false on a 2xx body that is not {ok:true}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 200 })));
    const { backendReady } = await freshModule();
    expect(await backendReady()).toBe(false);
  });

  it('probes only once per module instance, memoizing the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { backendReady } = await freshModule();

    await backendReady();
    await backendReady();
    await backendReady();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isBackendReadySync reflects the last resolved value only after backendReady() resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const { backendReady, isBackendReadySync } = await freshModule();

    expect(isBackendReadySync()).toBe(false);
    await backendReady();
    expect(isBackendReadySync()).toBe(true);
  });
});

describe('http.* auth header attachment', () => {
  it('attaches Authorization when a token is stored, omits it otherwise', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();

    await http.listPrinters();
    expect(fetchMock).toHaveBeenLastCalledWith('./api/v1/printers', expect.objectContaining({
      headers: expect.not.objectContaining({ Authorization: expect.anything() })
    }));

    localStorage.setItem('perfectfit.apiToken', 'secret-token');
    await http.listPrinters();
    expect(fetchMock).toHaveBeenLastCalledWith('./api/v1/printers', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret-token' })
    }));
  });
});

describe('http.* printers/projects translation', () => {
  it('listPrinters GETs /printers and returns the parsed array', async () => {
    const printers: PrinterProfile[] = [{ id: 'p1', name: 'X' } as PrinterProfile];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(printers), { status: 200 })));
    const { http } = await freshModule();
    expect(await http.listPrinters()).toEqual(printers);
  });

  it('getPrinter returns undefined on 404 instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const { http } = await freshModule();
    expect(await http.getPrinter('missing')).toBeUndefined();
  });

  it('getPrinter throws on a non-404 error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
    const { http } = await freshModule();
    await expect(http.getPrinter('x')).rejects.toThrow();
  });

  it('savePrinter PUTs JSON to /printers/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();
    const printer = { id: 'p1', name: 'X' } as PrinterProfile;

    await http.savePrinter(printer);

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/printers/p1', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(printer)
    }));
  });

  it('deletePrinter DELETEs /printers/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();

    await http.deletePrinter('p1');

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/printers/p1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('saveProject PUTs JSON to /projects/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();
    const project = { id: 'proj1' } as unknown as CalibrationProject;

    await http.saveProject(project);

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/projects/proj1', expect.objectContaining({ method: 'PUT' }));
  });

  it('throws on network/HTTP failures rather than swallowing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const { http } = await freshModule();
    await expect(http.listProjects()).rejects.toThrow();
  });
});

describe('http.* settings translation', () => {
  it('getSettings returns null for the 200+null unset-settings response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })));
    const { http } = await freshModule();
    expect(await http.getSettings()).toBeNull();
  });

  it('getSettings returns the parsed settings object when set', async () => {
    const settings: AppSettings = { theme: 'dark', largeText: false, defaultMode: 'coach', mvsSafetyMargin: 0.85 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(settings), { status: 200 })));
    const { http } = await freshModule();
    expect(await http.getSettings()).toEqual(settings);
  });

  it('putSettings PUTs JSON to /settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();
    const settings: AppSettings = { theme: 'light', largeText: true, defaultMode: 'expert', mvsSafetyMargin: 0.9 };

    await http.putSettings(settings);

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/settings', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(settings)
    }));
  });
});

describe('http.* photos translation', () => {
  function meta(id: string): Omit<StoredPhoto, 'blob'> {
    return {
      id, projectId: 'proj1', stepId: 'temperature', attemptId: 'a1',
      createdAt: '2026-01-01T00:00:00.000Z', name: 'x.png', type: 'image/png'
    };
  }

  it('savePhoto PUTs the blob body with metadata as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();
    const blob = new Blob(['bytes'], { type: 'image/png' });
    const photo: StoredPhoto = { ...meta('photo1'), blob };

    await http.savePhoto(photo);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^\.\/api\/v1\/photos\/photo1\?/);
    expect(url).toContain('projectId=proj1');
    expect(url).toContain('stepId=temperature');
    expect(url).toContain('name=x.png');
    expect(init).toEqual(expect.objectContaining({ method: 'PUT', body: blob }));
  });

  it('getPhotosForProject assembles full StoredPhoto objects with populated blobs', async () => {
    const metaList = [meta('photo1')];
    const blobBytes = new Blob(['hello'], { type: 'image/png' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(metaList), { status: 200 })) // list metadata
      .mockResolvedValueOnce(new Response(blobBytes, { status: 200 })); // binary fetch
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();

    const photos = await http.getPhotosForProject('proj1');

    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe('photo1');
    expect(photos[0].projectId).toBe('proj1');
    expect(photos[0].blob).toBeInstanceOf(Blob);
    expect(await photos[0].blob.text()).toBe('hello');
    expect(fetchMock).toHaveBeenNthCalledWith(1, './api/v1/projects/proj1/photos', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, './api/v1/photos/photo1', expect.anything());
  });

  it('deletePhoto DELETEs /photos/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();

    await http.deletePhoto('photo1');

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/photos/photo1', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('http.bulkErase', () => {
  it('DELETEs /data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();

    await http.bulkErase();

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/data', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('server URL config', () => {
  it('defaults to the relative API base when no server URL is stored (no regression)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http } = await freshModule();

    await http.listPrinters();

    expect(fetchMock).toHaveBeenCalledWith('./api/v1/printers', expect.anything());
  });

  it('builds absolute URLs once a server URL is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http, setStoredServerUrl } = await freshModule();

    setStoredServerUrl('http://192.168.1.50:8090');
    await http.listPrinters();

    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.50:8090/api/v1/printers', expect.anything());
  });

  it('strips a trailing slash on the stored server URL before appending /api/v1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http, setStoredServerUrl } = await freshModule();

    setStoredServerUrl('http://192.168.1.50:8090/');
    await http.listPrinters();

    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.50:8090/api/v1/printers', expect.anything());
  });

  it('detectBackend probes the absolute health endpoint once a server URL is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { backendReady, setStoredServerUrl } = await freshModule();

    setStoredServerUrl('https://server.example');
    expect(await backendReady()).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('https://server.example/api/v1/health', expect.anything());
  });

  it('reverts to the relative API base after the server URL is cleared', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { http, setStoredServerUrl, clearStoredServerUrl } = await freshModule();

    setStoredServerUrl('http://192.168.1.50:8090');
    clearStoredServerUrl();
    await http.listPrinters();

    expect(fetchMock).toHaveBeenLastCalledWith('./api/v1/printers', expect.anything());
  });

  it('setStoredServerUrl forces backendReady() to re-probe rather than return a stale cached result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 200 })) // relative probe: not reachable
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // absolute probe: reachable
    vi.stubGlobal('fetch', fetchMock);
    const { backendReady, setStoredServerUrl } = await freshModule();

    expect(await backendReady()).toBe(false);

    setStoredServerUrl('http://192.168.1.50:8090');
    expect(await backendReady()).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('getStoredServerUrl/setStoredServerUrl/clearStoredServerUrl round-trip through localStorage under a shared key', async () => {
    const { getStoredServerUrl, setStoredServerUrl, clearStoredServerUrl } = await freshModule();

    expect(getStoredServerUrl()).toBeNull();

    setStoredServerUrl('http://example.test:8090');
    expect(getStoredServerUrl()).toBe('http://example.test:8090');
    expect(localStorage.getItem('perfectfit.serverUrl')).toBe('http://example.test:8090');

    clearStoredServerUrl();
    expect(getStoredServerUrl()).toBeNull();
  });
});

describe('isValidServerUrl / setStoredServerUrl validation', () => {
  it('accepts http and https URLs', async () => {
    const { isValidServerUrl } = await freshModule();
    expect(isValidServerUrl('http://localhost:8090')).toBe(true);
    expect(isValidServerUrl('https://my-server.example')).toBe(true);
  });

  it('rejects non-http(s) protocols, e.g. javascript:', async () => {
    const { isValidServerUrl } = await freshModule();
    expect(isValidServerUrl('javascript:alert(1)')).toBe(false);
    expect(isValidServerUrl('file:///etc/passwd')).toBe(false);
    expect(isValidServerUrl('ftp://example.test')).toBe(false);
  });

  it('rejects unparseable input', async () => {
    const { isValidServerUrl } = await freshModule();
    expect(isValidServerUrl('not a url')).toBe(false);
    expect(isValidServerUrl('')).toBe(false);
  });

  it('setStoredServerUrl throws and does not persist an invalid URL', async () => {
    const { setStoredServerUrl, getStoredServerUrl } = await freshModule();

    expect(() => setStoredServerUrl('javascript:alert(1)')).toThrow();
    expect(getStoredServerUrl()).toBeNull();
  });

  it('setStoredServerUrl trims surrounding whitespace before validating/storing', async () => {
    const { setStoredServerUrl, getStoredServerUrl } = await freshModule();

    setStoredServerUrl('  http://example.test:8090  ');

    expect(getStoredServerUrl()).toBe('http://example.test:8090');
  });
});

describe('isDesktopRuntime', () => {
  it('is false when there is no window global (bare Node / this test environment)', async () => {
    const { isDesktopRuntime } = await freshModule();
    expect(isDesktopRuntime()).toBe(false);
  });

  it('is false when window exists but carries no __TAURI__ global', async () => {
    vi.stubGlobal('window', {});
    const { isDesktopRuntime } = await freshModule();
    expect(isDesktopRuntime()).toBe(false);
  });

  it('is true when window carries a __TAURI__ global', async () => {
    vi.stubGlobal('window', { __TAURI__: {} });
    const { isDesktopRuntime } = await freshModule();
    expect(isDesktopRuntime()).toBe(true);
  });
});

describe('token accessors', () => {
  it('getStoredToken/setStoredToken/clearStoredToken round-trip through localStorage under a shared key', async () => {
    const { getStoredToken, setStoredToken, clearStoredToken } = await freshModule();

    expect(getStoredToken()).toBeNull();

    setStoredToken('abc123');
    expect(getStoredToken()).toBe('abc123');
    expect(localStorage.getItem('perfectfit.apiToken')).toBe('abc123');

    clearStoredToken();
    expect(getStoredToken()).toBeNull();
  });
});

describe('ApiError', () => {
  it('carries the HTTP status on GET failures so callers can distinguish 401 from other errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    const { http, ApiError } = await freshModule();

    await expect(http.listProjects()).rejects.toMatchObject({ status: 401 });
    try {
      await http.listProjects();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });

  it('getSettings rejects with an ApiError carrying status on non-ok responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    const { http, ApiError } = await freshModule();

    await expect(http.getSettings()).rejects.toBeInstanceOf(ApiError);
    await expect(http.getSettings()).rejects.toMatchObject({ status: 401 });
  });
});
