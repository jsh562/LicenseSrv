# syntax=docker/dockerfile:1
# Single runtime image for the License API (E006, ADR-0006). The build stage installs ONLY what is
# needed to compile + run — production deps plus the TypeScript compiler and Node types — never the test
# or lint toolchain. It compiles to dist/, then prunes the build-only packages so the slim non-root final
# stage carries just dist/ + production node_modules + migrations. One image, two commands: serve / migrate.

# --- build: prod deps + tsc, compile TS -> dist/, then prune build-only deps ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm install --no-save --no-audit --no-fund typescript@5.6.3 @types/node@22
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json \
  && npm prune --omit=dev --no-audit --no-fund

# --- runtime: slim, non-root, only what the app needs at run time ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
# Drop privileges: the built-in non-root `node` user (uid 1000). No secrets or writable app state here.
USER node
EXPOSE 8080
# Default command = serve. The migration job overrides this with: node dist/server/db/migrate.js
CMD ["node", "dist/server/main.js"]
