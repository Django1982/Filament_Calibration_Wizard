// Bearer-token auth. Off entirely when PERFECTFIT_API_TOKEN is unset/empty —
// this server is designed for a trusted single-user deployment where the
// token is opt-in hardening, not a full auth system.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const BEARER_PREFIX = 'Bearer ';

/** Constant-time-ish comparison that never throws on length mismatch (unlike node's raw timingSafeEqual). */
export function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Returns true if the request carries a valid `Authorization: Bearer <token>` header. */
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const provided = header.slice(BEARER_PREFIX.length);
  return tokensMatch(provided, expectedToken);
}
