// Entry point for the opt-in self-hosted persistence server. Standalone Node
// script — no build step, Node 24 strips types natively (`node server/index.ts`).
//
// PERFECTFIT_PORT defaults to 8787 for local/dev use; the Docker image
// overrides it to 80 via ENV (see Dockerfile) since the container serves
// both the API and the static SPA build (PERFECTFIT_STATIC_DIR) on one origin.
import { createServer } from './createServer.ts';
import { openDatabase } from './db.ts';

const dbPath = process.env.PERFECTFIT_DB_PATH || './perfectfit.sqlite3';
const port = Number(process.env.PERFECTFIT_PORT) || 8787;
const apiToken = process.env.PERFECTFIT_API_TOKEN || undefined;
const staticDir = process.env.PERFECTFIT_STATIC_DIR || './dist';

const db = openDatabase(dbPath);
const server = createServer({ db, apiToken, staticDir });

server.listen(port, () => {
  console.log(
    `PerfectFit server listening on port ${port} (db: ${dbPath}, static: ${staticDir}, auth: ${apiToken ? 'on' : 'off'})`
  );
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
