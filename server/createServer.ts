// Wires auth + routing + error handling around a plain node:http server.
// Exported separately from index.ts so tests can start it in-process on an
// ephemeral port without touching env vars or the real db file.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpError, sendError } from './http.ts';
import { isAuthorized } from './auth.ts';
import { dispatch, isHealthCheck } from './router.ts';
import { serveStatic } from './static.ts';
import { applyCorsHeaders, handlePreflight } from './cors.ts';
import type { PerfectFitDb } from './db.ts';

const API_PREFIX = '/api/v1/';

export interface ServerOptions {
  db: PerfectFitDb;
  /** Bearer token required for all routes except /api/v1/health. Unset/empty disables auth. */
  apiToken?: string;
  /** Directory the built SPA is served from for any non-API path. Defaults to vite's outDir. */
  staticDir?: string;
}

export function createServer({ db, apiToken, staticDir = './dist' }: ServerOptions): Server {
  return createHttpServer((req, res) => {
    // A single request's failure must never take the process down.
    void handleRequest(req, res, db, apiToken, staticDir).catch((err) => {
      // The request/response streams may already be half-consumed at this
      // point; guard against writing headers twice.
      if (!res.headersSent) {
        console.error('Unhandled server error:', err);
        sendError(res, 500, 'Internal server error');
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: PerfectFitDb,
  apiToken: string | undefined,
  staticDir: string
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (!url.pathname.startsWith(API_PREFIX)) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, staticDir);
    } else {
      sendError(res, 404, 'Not found');
    }
    return;
  }

  applyCorsHeaders(res, apiToken);
  if (handlePreflight(req, res, apiToken)) return;

  if (apiToken && !isHealthCheck(req.method, url.pathname)) {
    if (!isAuthorized(req, apiToken)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
  }

  try {
    await dispatch(req, res, db);
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.message);
      return;
    }
    throw err;
  }
}
