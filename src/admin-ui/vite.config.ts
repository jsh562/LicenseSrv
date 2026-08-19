/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEFAULT_API_PORT = 8080;

/**
 * Resolve the API port the dev proxy should target.
 *
 * The no-Docker path (`npm run start:native`) picks a free port at setup and RE-PICKS it at start if the
 * recorded one has since been taken — commonly because a `docker compose` stack is holding 8080. The chosen
 * value is written back to `.env.native`, so reading it here is what keeps the console pointed at the API
 * instead of failing with an opaque proxy error after a relocation.
 *
 * Falls back to 8080 whenever the file is absent or unparseable: Docker-only users never create
 * `.env.native`, and that path must keep working untouched. Never throws — a broken env file must not take
 * down `vite dev`.
 */
function resolveApiPort(): number {
  try {
    const envPath = fileURLToPath(new URL("../../.env.native", import.meta.url));
    const match = /^PORT=(\d+)\s*$/m.exec(readFileSync(envPath, "utf8"));
    if (!match?.[1]) return DEFAULT_API_PORT;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_API_PORT;
  } catch {
    return DEFAULT_API_PORT;
  }
}

// The admin SPA is served same-origin with the API; dev proxies /admin to the Fastify server so the
// session + CSRF cookies (Path=/admin) are first-party. Tests run under jsdom with a mocked fetch.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": { target: `http://localhost:${resolveApiPort()}`, changeOrigin: false },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/vite-env.d.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
