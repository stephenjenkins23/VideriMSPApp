# VFI — one image, two entrypoints (read API and poller daemon).
#
# NOTE FOR REVIEWERS: this file was authored against the real build (npm ci +
# tsc + the dist entrypoints are all verified working locally) but has NOT been
# `docker build`-tested — Docker is not installed on the machine it was written
# on. Treat the layer mechanics as unverified until someone runs it once.

# ── build ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
# Deterministic install from the lockfile, before source, so the layer caches.
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ── runtime ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production deps only — no typescript, no @types in the running image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# public/ is the entire frontend (single-file console). Forgetting it yields a
# working API that serves a 404 for the dashboard.
COPY public ./public
# schema + migrations travel with the image so a deploy can apply them.
COPY src/db/schema.sql ./src/db/schema.sql
COPY src/db/migrations ./src/db/migrations

# Run unprivileged. node:alpine ships a `node` user (uid 1000).
USER node

# Inside a container 127.0.0.1 is unreachable from outside it; config.ts
# defaults to 127.0.0.1, so this override is REQUIRED, not cosmetic.
ENV VFI_API_HOST=0.0.0.0
ENV VFI_API_PORT=8080
EXPOSE 8080

# Entrypoints deliberately call node directly rather than `npm run serve`:
# the npm scripts pass --env-file=.env, which does not exist in the image and
# would abort. In a container, configuration arrives through the environment.
#   API    : node dist/api/run-server.js          (this default)
#   poller : node dist/pipeline/run-poller.js     (override CMD)
# Never add --allow-anonymous here; it disables auth on the whole read API.
CMD ["node", "dist/api/run-server.js"]
