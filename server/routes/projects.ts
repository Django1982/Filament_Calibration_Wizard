import { sendJson, sendNoContent } from '../http.ts';
import { getHandler, listHandler, putHandler } from './jsonResource.ts';
import type { RouteHandler } from '../types.ts';

export const listProjects = listHandler('projects');
export const getProject = getHandler('projects');
export const putProject = putHandler('projects');

/** Deletes the project and cascade-deletes its photos in one transaction. Idempotent: always 204. */
export const deleteProject: RouteHandler = ({ res, db, params }) => {
  db.deleteProjectCascade(params.id);
  sendNoContent(res);
};

/** Lists photo METADATA only (no blob bytes) for a project. */
export const listProjectPhotos: RouteHandler = ({ res, db, params }) => {
  const photos = db.listPhotoMetaByProject(params.id);
  sendJson(res, 200, photos);
};
