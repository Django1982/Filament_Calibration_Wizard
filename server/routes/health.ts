import { sendJson } from '../http.ts';
import type { RouteHandler } from '../types.ts';

export const getHealth: RouteHandler = ({ res }) => {
  sendJson(res, 200, { ok: true });
};
