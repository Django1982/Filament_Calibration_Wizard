// Minimal path-template router — no dependency, ~16 routes doesn't need a real framework.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './http.ts';
import { getHealth } from './routes/health.ts';
import { deletePrinter, getPrinter, listPrinters, putPrinter } from './routes/printers.ts';
import {
  deleteProject,
  getProject,
  listProjectPhotos,
  listProjects,
  putProject
} from './routes/projects.ts';
import { deletePhoto, getPhoto, putPhoto } from './routes/photos.ts';
import { getSettings, putSettings } from './routes/settings.ts';
import { eraseAllData } from './routes/bulk.ts';
import type { PerfectFitDb } from './db.ts';
import type { RouteContext, RouteHandler } from './types.ts';

interface RouteDef {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function route(method: string, path: string, handler: RouteHandler): RouteDef {
  return { method, segments: path.split('/').filter(Boolean), handler };
}

// Order matters only in that a more specific literal path must not be shadowed
// by a param segment of the same length — none of these collide, but keep the
// longer /projects/:id/photos path grouped with its siblings for readability.
const ROUTES: RouteDef[] = [
  route('GET', '/api/v1/health', getHealth),

  route('GET', '/api/v1/printers', listPrinters),
  route('GET', '/api/v1/printers/:id', getPrinter),
  route('PUT', '/api/v1/printers/:id', putPrinter),
  route('DELETE', '/api/v1/printers/:id', deletePrinter),

  route('GET', '/api/v1/projects', listProjects),
  route('GET', '/api/v1/projects/:id', getProject),
  route('PUT', '/api/v1/projects/:id', putProject),
  route('DELETE', '/api/v1/projects/:id', deleteProject),
  route('GET', '/api/v1/projects/:id/photos', listProjectPhotos),

  route('GET', '/api/v1/photos/:id', getPhoto),
  route('PUT', '/api/v1/photos/:id', putPhoto),
  route('DELETE', '/api/v1/photos/:id', deletePhoto),

  route('GET', '/api/v1/settings', getSettings),
  route('PUT', '/api/v1/settings', putSettings),

  route('DELETE', '/api/v1/data', eraseAllData)
];

interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string>;
}

function matchRoute(method: string, pathname: string): MatchResult | undefined {
  const pathSegments = pathname.split('/').filter(Boolean);
  for (const candidate of ROUTES) {
    if (candidate.method !== method) continue;
    if (candidate.segments.length !== pathSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < candidate.segments.length; i++) {
      const seg = candidate.segments[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(pathSegments[i]);
      } else if (seg !== pathSegments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: candidate.handler, params };
  }
  return undefined;
}

/** Resolves the request to a route handler and invokes it. 404s unmatched paths/methods. */
export async function dispatch(req: IncomingMessage, res: ServerResponse, db: PerfectFitDb): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = matchRoute(req.method ?? 'GET', url.pathname);
  if (!match) {
    sendError(res, 404, 'Not found');
    return;
  }
  const ctx: RouteContext = { req, res, db, params: match.params, url };
  await match.handler(ctx);
}

/** Exposed for the auth middleware, which needs to allow health checks even when a token is configured. */
export function isHealthCheck(method: string | undefined, pathname: string): boolean {
  return method === 'GET' && pathname === '/api/v1/health';
}
