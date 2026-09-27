# --- Build stage ---
FROM node:24-slim AS build
WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and build the static bundle
COPY . .
RUN npm run build   # typechecks, then bundles to dist/

# --- Runtime stage ---
# node:24-slim (not busybox) because the runtime now also serves the opt-in
# self-hosted persistence API (server/, Node's built-in http+sqlite, no
# npm deps, no build step — Node 24 strips TS types natively). The server
# serves the static SPA build itself (see server/static.ts) so API and
# static app share one origin with zero CORS/config in Docker.
FROM node:24-slim AS runtime
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server ./server

ENV PERFECTFIT_PORT=80
ENV PERFECTFIT_DB_PATH=/data/perfectfit.sqlite3
ENV PERFECTFIT_STATIC_DIR=./dist

EXPOSE 80
# FORGE-NOTE: node:24-slim has neither wget nor curl (the task spec's original
# `wget -qO-` healthcheck fails with "wget: not found" — verified against a
# real build/run of this image); node's own built-in fetch is always present.
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]