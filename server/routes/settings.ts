import { readJsonBody, sendJson, sendNoContent } from '../http.ts';
import type { RouteHandler } from '../types.ts';

export const getSettings: RouteHandler = ({ res, db }) => {
  const json = db.getSettings();
  // FORGE-NOTE: spec allowed either `null` body or 404 when unset; chose 200+null
  // since "no settings saved yet" is normal startup state, not an error.
  sendJson(res, 200, json ? JSON.parse(json) : null);
};

export const putSettings: RouteHandler = async ({ req, res, db }) => {
  const body = await readJsonBody(req);
  db.upsertSettings(JSON.stringify(body));
  sendNoContent(res);
};
