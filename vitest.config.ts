import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/server/**/*.{test,spec}.ts"],
    // Real-Postgres integration tests start a fresh container; allow ample time.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Integration tests share a single container via globalSetup; run serially for determinism.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts"],
      exclude: ["src/server/**/*.{test,spec}.ts", "src/server/**/__tests__/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
