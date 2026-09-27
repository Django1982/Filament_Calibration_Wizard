import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PerfectFitDb } from './db.ts';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  db: PerfectFitDb;
  /** Path params extracted by the router, e.g. { id: '...' } for /printers/:id */
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;
