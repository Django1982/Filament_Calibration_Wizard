// SQLite persistence layer for the opt-in self-hosted server.
//
// Projects/printers are stored as opaque JSON blobs deliberately — this
// mirrors the existing IndexedDB object-store model in src/storage/db.ts
// (schemaless whole-object put/get). The server never needs to understand
// CalibrationProject's internal shape.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// FORGE-NOTE: `node:sqlite` is prefix-only (no bare `sqlite` builtin exists),
// which trips up Vite/vitest's SSR module resolution when tests import this
// file (it drops the `node:` prefix while resolving, then fails to load a
// bare `sqlite` module). Loading it via createRequire sidesteps Vite's
// static import analysis entirely and defers to Node's own resolver, which
// handles `node:`-prefixed builtins natively both at runtime and in tests.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS printers (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, created_at TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_by_project ON photos(project_id);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
`;

/** The two tables that just store an opaque JSON blob keyed by id. */
export type JsonTable = 'projects' | 'printers';

export interface JsonRow {
  id: string;
  updatedAt: string;
  json: string;
}

export interface PhotoMetaRow {
  id: string;
  projectId: string;
  stepId: string;
  attemptId: string;
  createdAt: string;
  name: string;
  type: string;
}

export interface PhotoRow extends PhotoMetaRow {
  data: Uint8Array;
}

export interface PerfectFitDb {
  listJson(table: JsonTable): JsonRow[];
  getJson(table: JsonTable, id: string): JsonRow | undefined;
  upsertJson(table: JsonTable, id: string, json: string): void;
  deleteJson(table: JsonTable, id: string): void;
  deleteProjectCascade(id: string): void;
  listPhotoMetaByProject(projectId: string): PhotoMetaRow[];
  getPhoto(id: string): PhotoRow | undefined;
  upsertPhoto(meta: PhotoMetaRow, data: Uint8Array): void;
  deletePhoto(id: string): void;
  getSettings(): string | undefined;
  upsertSettings(json: string): void;
  eraseAll(): void;
  close(): void;
}

/** Opens (creating if necessary) the sqlite file at `path` and applies the schema. */
export function openDatabase(path: string): PerfectFitDb {
  // node:sqlite doesn't create parent directories for a file path on its own.
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const jsonStatements = {
    projects: {
      list: db.prepare('SELECT id, updated_at, json FROM projects ORDER BY id'),
      get: db.prepare('SELECT id, updated_at, json FROM projects WHERE id = ?'),
      upsert: db.prepare(
        'INSERT INTO projects (id, updated_at, json) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json'
      ),
      delete: db.prepare('DELETE FROM projects WHERE id = ?')
    },
    printers: {
      list: db.prepare('SELECT id, updated_at, json FROM printers ORDER BY id'),
      get: db.prepare('SELECT id, updated_at, json FROM printers WHERE id = ?'),
      upsert: db.prepare(
        'INSERT INTO printers (id, updated_at, json) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json'
      ),
      delete: db.prepare('DELETE FROM printers WHERE id = ?')
    }
  } as const;

  const deletePhotosByProject = db.prepare('DELETE FROM photos WHERE project_id = ?');
  const listPhotoMeta = db.prepare(
    'SELECT id, project_id, step_id, attempt_id, created_at, name, type FROM photos WHERE project_id = ? ORDER BY created_at'
  );
  const getPhotoStmt = db.prepare(
    'SELECT id, project_id, step_id, attempt_id, created_at, name, type, data FROM photos WHERE id = ?'
  );
  const upsertPhotoStmt = db.prepare(
    'INSERT INTO photos (id, project_id, step_id, attempt_id, created_at, name, type, data) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, step_id = excluded.step_id, ' +
      'attempt_id = excluded.attempt_id, created_at = excluded.created_at, name = excluded.name, ' +
      'type = excluded.type, data = excluded.data'
  );
  const deletePhotoStmt = db.prepare('DELETE FROM photos WHERE id = ?');

  const getSettingsStmt = db.prepare('SELECT json FROM settings WHERE id = 1');
  const upsertSettingsStmt = db.prepare(
    'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json'
  );

  function toPhotoMeta(row: Record<string, unknown>): PhotoMetaRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      stepId: row.step_id as string,
      attemptId: row.attempt_id as string,
      createdAt: row.created_at as string,
      name: row.name as string,
      type: row.type as string
    };
  }

  return {
    listJson(table) {
      const rows = jsonStatements[table].list.all() as Array<{ id: string; updated_at: string; json: string }>;
      return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at, json: r.json }));
    },

    getJson(table, id) {
      const row = jsonStatements[table].get.get(id) as
        | { id: string; updated_at: string; json: string }
        | undefined;
      if (!row) return undefined;
      return { id: row.id, updatedAt: row.updated_at, json: row.json };
    },

    upsertJson(table, id, json) {
      jsonStatements[table].upsert.run(id, new Date().toISOString(), json);
    },

    deleteJson(table, id) {
      jsonStatements[table].delete.run(id);
    },

    deleteProjectCascade(id) {
      db.exec('BEGIN');
      try {
        jsonStatements.projects.delete.run(id);
        deletePhotosByProject.run(id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    listPhotoMetaByProject(projectId) {
      const rows = listPhotoMeta.all(projectId) as Array<Record<string, unknown>>;
      return rows.map(toPhotoMeta);
    },

    getPhoto(id) {
      const row = getPhotoStmt.get(id) as (Record<string, unknown> & { data: Uint8Array }) | undefined;
      if (!row) return undefined;
      return { ...toPhotoMeta(row), data: row.data };
    },

    upsertPhoto(meta, data) {
      upsertPhotoStmt.run(
        meta.id,
        meta.projectId,
        meta.stepId,
        meta.attemptId,
        meta.createdAt,
        meta.name,
        meta.type,
        data
      );
    },

    deletePhoto(id) {
      deletePhotoStmt.run(id);
    },

    getSettings() {
      const row = getSettingsStmt.get() as { json: string } | undefined;
      return row?.json;
    },

    upsertSettings(json) {
      upsertSettingsStmt.run(json);
    },

    eraseAll() {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM projects');
        db.exec('DELETE FROM printers');
        db.exec('DELETE FROM photos');
        db.exec('DELETE FROM settings');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      db.close();
    }
  };
}
