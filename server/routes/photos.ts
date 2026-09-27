import { HttpError, readRawBody, sendError, sendNoContent } from '../http.ts';
import type { PhotoMetaRow } from '../db.ts';
import type { RouteHandler } from '../types.ts';

const REQUIRED_QUERY_PARAMS = ['projectId', 'stepId', 'attemptId', 'createdAt', 'name', 'type'] as const;

// The wizard's file picker is `accept="image/*"` (see src/ui/wizard.ts) and
// only ever uploads camera/gallery photos — this mirrors that intent as a
// server-side allowlist. `type` is client-supplied and otherwise gets stored
// verbatim and echoed back as the Content-Type response header on GET, which
// is a stored content-type-injection/XSS vector (e.g. `type=text/html`) if
// left unvalidated.
const ALLOWED_PHOTO_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/bmp',
  'image/avif'
]);

function readPhotoMeta(url: URL, id: string): PhotoMetaRow {
  const values: Record<string, string> = {};
  for (const key of REQUIRED_QUERY_PARAMS) {
    const value = url.searchParams.get(key);
    if (!value) {
      throw new HttpError(400, `Missing required query param: ${key}`);
    }
    values[key] = value;
  }
  if (!ALLOWED_PHOTO_TYPES.has(values.type.toLowerCase())) {
    throw new HttpError(400, `Unsupported photo type: ${values.type}`);
  }
  return {
    id,
    projectId: values.projectId,
    stepId: values.stepId,
    attemptId: values.attemptId,
    createdAt: values.createdAt,
    name: values.name,
    type: values.type
  };
}

export const getPhoto: RouteHandler = ({ res, db, params }) => {
  const photo = db.getPhoto(params.id);
  if (!photo) {
    sendError(res, 404, 'Not found');
    return;
  }
  // Defense-in-depth: type is allowlisted on write (see readPhotoMeta above),
  // but nosniff means even a row written before this check existed can't be
  // reinterpreted as HTML/script by a browser that ignores Content-Type.
  res.writeHead(200, {
    'Content-Type': photo.type,
    'Content-Length': photo.data.length,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(Buffer.from(photo.data));
};

const MAX_PHOTO_BYTES = 50 * 1024 * 1024; // 50MB — generous for a phone camera photo, not unbounded

export const putPhoto: RouteHandler = async ({ req, res, db, params, url }) => {
  const meta = readPhotoMeta(url, params.id);
  const data = await readRawBody(req, MAX_PHOTO_BYTES);
  db.upsertPhoto(meta, data);
  sendNoContent(res);
};

export const deletePhoto: RouteHandler = ({ res, db, params }) => {
  db.deletePhoto(params.id);
  sendNoContent(res);
};
