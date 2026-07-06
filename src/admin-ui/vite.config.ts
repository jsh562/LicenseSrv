/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The admin SPA is served same-origin with the API; dev proxies /admin to the Fastify server so the
// session + CSRF cookies (Path=/admin) are first-party. Tests run under jsdom with a mocked fetch.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": { target: "http://localhost:8080", changeOrigin: false },
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
