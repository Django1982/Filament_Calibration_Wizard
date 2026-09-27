// Small hand-rolled helpers around node:http — no framework, matches the
// project's dependency-light philosophy (see root CLAUDE.md).
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Thrown by route handlers to produce a specific JSON error response. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Structured JSON bodies (projects/printers/settings) are opaque blobs but
// small — no legitimate reason for one to approach this size. Caps memory
// use per-request against an unauthenticated client sending an arbitrarily
// large body (readRawBody has no cap of its own; every caller must pick one).
const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024; // 1MB

/** Reads the full request body and JSON.parses it. Throws HttpError(400) on malformed JSON, HttpError(413) if it exceeds maxBytes. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) {
    throw new HttpError(400, 'Request body is required');
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

/** Reads the full request body as a Buffer without any parsing (used for photo uploads). Rejects with HttpError(413) past maxBytes. */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // FORGE-NOTE: deliberately don't req.destroy() here — verified that
        // destroying the request mid-stream tears down the shared socket
        // before the 413 response can be written (client sees ECONNRESET,
        // not 413). Instead we stop buffering (bounding memory, which is the
        // actual vulnerability) and keep draining/discarding the rest of the
        // body so the connection stays protocol-correct and the caller can
        // still send a clean error response on it.
        if (!settled) {
          settled = true;
          reject(new HttpError(413, `Request body exceeds the ${maxBytes}-byte limit`));
        }
        chunks.length = 0;
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}
