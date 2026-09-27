// Test helper: boots a real server against a temp sqlite file on an
// ephemeral port so tests can hit it with plain fetch().
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server/createServer.ts';
import { openDatabase, type PerfectFitDb } from '../../server/db.ts';

export interface TestServerHandle {
  baseUrl: string;
  db: PerfectFitDb;
  close(): Promise<void>;
}

export async function startTestServer(apiToken?: string, staticDir?: string): Promise<TestServerHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'perfectfit-server-test-'));
  const dbPath = join(dir, 'test.sqlite3');
  const db = openDatabase(dbPath);
  const server = createServer({ db, apiToken, staticDir });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    db,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
          if (err) reject(err);
          else resolve();
        });
      })
  };
}
