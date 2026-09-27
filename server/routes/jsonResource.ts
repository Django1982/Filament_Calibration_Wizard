// Shared CRUD handlers for the two opaque-JSON-blob tables (projects, printers).
// Both resources have identical storage semantics; only the delete behavior
// diverges (projects cascade-delete photos), so that stays out of here.
import { HttpError, readJsonBody, sendError, sendJson, sendNoContent } from '../http.ts';
import type { JsonTable } from '../db.ts';
import type { RouteHandler } from '../types.ts';

function parseJsonRow(json: string): unknown {
  // Rows are only ever written via upsertJson below, so this should never
  // fail — but guard anyway rather than letting a corrupt row 500 the list endpoint.
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function listHandler(table: JsonTable): RouteHandler {
  return ({ res, db }) => {
    const rows = db.listJson(table).map((r) => parseJsonRow(r.json));
    sendJson(res, 200, rows);
  };
}

export function getHandler(table: JsonTable): RouteHandler {
  return ({ res, db, params }) => {
    const row = db.getJson(table, params.id);
    if (!row) {
      sendError(res, 404, 'Not found');
      return;
    }
    sendJson(res, 200, parseJsonRow(row.json));
  };
}

export function putHandler(table: JsonTable): RouteHandler {
  return async ({ req, res, db, params }) => {
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'Request body must be a JSON object');
    }
    const bodyId = (body as Record<string, unknown>).id;
    if (typeof bodyId === 'string' && bodyId !== params.id) {
      throw new HttpError(400, 'Body id does not match URL id');
    }
    db.upsertJson(table, params.id, JSON.stringify(body));
    sendNoContent(res);
  };
}

/** Simple (non-cascading) delete — used for printers. Idempotent: 204 regardless of prior existence. */
export function deleteHandler(table: JsonTable): RouteHandler {
  return ({ res, db, params }) => {
    db.deleteJson(table, params.id);
    sendNoContent(res);
  };
}
