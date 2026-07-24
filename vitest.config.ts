import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/server/**/*.{test,spec}.ts", "observability/**/*.{test,spec}.ts"],
    // Real-Postgres integration tests start a fresh container; allow ample time.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Integration tests share a single container via globalSetup; run serially for determinism.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      // The broad `src/server/**/*.ts` glob already covers the E015 lease module; it is listed explicitly so
      // the ≥80% line+branch gate is unambiguously enforced on `src/server/modules/lease/**` (T001/T042).
      include: ["src/server/**/*.ts", "src/server/modules/lease/**/*.ts"],
      exclude: [
        "src/server/**/*.{test,spec}.ts",
        "src/server/**/__tests__/**",
        // Process-level entrypoint wrapper (listen/signals/CLI) — validated by the entrypoint
        // integration test (buildServer + startServer) and the Docker image smoke, not line-counted.
        "src/server/main.ts",
      ],
      reporter: ["text-summary"],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
