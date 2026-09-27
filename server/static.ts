// Serves the built SPA (dist/ by default) alongside the API. This app uses
// hash-based routing (see src/app.ts), so the server never needs to resolve
// deep paths — only '/' really matters — but the SPA fallback (unmatched
// path -> index.html) is cheap and correct to implement properly anyway.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './http.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const DEFAULT_MIME = 'application/octet-stream';

function contentTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? DEFAULT_MIME;
}

/** Resolves `pathname` against `staticRoot`, rejecting anything that escapes the root (path traversal). */
function resolveWithinRoot(staticRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const rootAbs = resolve(staticRoot);
  const candidate = resolve(rootAbs, `.${decoded}`);
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) {
    return undefined;
  }
  return candidate;
}

function isExistingFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves a file from `staticRoot` for GET/HEAD requests, falling back to
 * `index.html` (SPA fallback) when the exact path isn't a file. Callers must
 * only invoke this for GET/HEAD; other methods aren't handled here.
 *
 * FORGE-NOTE: reads the whole file into memory per request (readFileSync)
 * rather than streaming — the SPA bundle is a handful of small/medium files
 * (see vite.config.ts outDir), so this trades a bit of memory for a plain
 * single res.end(buffer) response, matching the rest of this router's style
 * (see routes/photos.ts) and avoiding stream/keep-alive edge cases entirely.
 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, staticRoot: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const resolved = resolveWithinRoot(staticRoot, url.pathname);
  if (!resolved) {
    sendError(res, 404, 'Not found');
    return;
  }

  const filePath = isExistingFile(resolved) ? resolved : resolve(staticRoot, 'index.html');
  if (!isExistingFile(filePath)) {
    sendError(res, 404, 'Not found');
    return;
  }

  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch {
    sendError(res, 404, 'Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': contentTypeFor(filePath), 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}
