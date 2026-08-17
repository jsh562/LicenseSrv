# syntax=docker/dockerfile:1
# Single runtime image for the License API (E006, ADR-0006). The build stage installs ONLY what is
# needed to compile + run — production deps plus the TypeScript compiler and Node types — never the test
# or lint toolchain. It compiles to dist/, then prunes the build-only packages so the slim non-root final
# stage carries just dist/ + production node_modules + migrations. One image, two commands: serve / migrate.

# --- build: prod deps + tsc, compile TS -> dist/, then prune build-only deps ---
# Base image digest-pinned for reproducible, tamper-resistant release builds (E011 OR-006).
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm install --no-save --no-audit --no-fund typescript@5.6.3 @types/node@22
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json \
  && npm prune --omit=dev --no-audit --no-fund

# --- runtime: slim, non-root, only what the app needs at run time ---
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The signing/verifier core is a prebuilt wasm-pack package (JS + .wasm runtime assets, not TS), so `tsc`
# never emits it into dist/. Copy it to the path the compiled `dist/server/modules/signing/token.js`
# resolves (`../../../bindings/wasm/pkg`), or the API cannot load the signer at boot.
COPY --from=build /app/src/bindings/wasm/pkg ./dist/bindings/wasm/pkg
COPY migrations ./migrations
COPY package.json ./
# Drop privileges: the built-in non-root `node` user (uid 1000). No secrets or writable app state here.
USER node
EXPOSE 8080
# Default command = serve. Tracing is loaded as an ESM PRELOAD via `--import` (HINT-001) so the OTel SDK
# starts and patches pg/fastify/http BEFORE the app imports them. `--import` (not `--require`) is used
# because this is an ESM ("type":"module") project: `--require` cannot load the ESM tracing module. The
# preload is fail-open — a down/absent Collector never affects boot. The migration job overrides this CMD
# with: node dist/server/db/migrate.js
CMD ["node", "--import", "./dist/server/observability/tracing.js", "dist/server/main.js"]
