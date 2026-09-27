import { sendNoContent } from '../http.ts';
import type { RouteHandler } from '../types.ts';

/** Erases all projects, printers, photos, and settings in one transaction. Backs the client's "erase all data" button. */
export const eraseAllData: RouteHandler = ({ res, db }) => {
  db.eraseAll();
  sendNoContent(res);
};
