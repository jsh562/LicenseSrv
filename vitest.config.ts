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
      // The E016 usage module is likewise listed explicitly so the ≥80% line+branch gate is unambiguously
      // enforced on `src/server/modules/usage/**` (T001/T044).
      // The E017 policy module is likewise listed explicitly so the ≥80% line+branch gate is unambiguously
      // enforced on `src/server/modules/policy/**` (E017 T001; the per-directory threshold below lands in T053).
      // The E018 reseller module is likewise listed explicitly so the ≥80% line+branch gate is unambiguously
      // enforced on `src/server/modules/reseller/**` (E018 T001; the per-directory threshold below lands in T048).
      include: [
        "src/server/**/*.ts",
        "src/server/modules/lease/**/*.ts",
        "src/server/modules/usage/**/*.ts",
        "src/server/modules/policy/**/*.ts",
        "src/server/modules/reseller/**/*.ts",
      ],
      exclude: [
        "src/server/**/*.{test,spec}.ts",
        "src/server/**/__tests__/**",
        // Process-level entrypoint wrapper (listen/signals/CLI) — validated by the entrypoint
        // integration test (buildServer + startServer) and the Docker image smoke, not line-counted.
        "src/server/main.ts",
      ],
      reporter: ["text-summary"],
      // The project-wide gate PLUS a per-directory threshold on the E017 policy module (T053): the sandboxed
      // evaluator, the bounded effect applier, author-time validation, the context builder, highest-priority-wins
      // evaluation, the rule repo/routes, and the retention worker must each hold ≥80% line+branch on their own,
      // independent of the global rollup — the load-bearing sandbox/effect-clamp/determinism evidence ADR-0014
      // requires cannot be diluted by unrelated coverage.
      thresholds: {
        lines: 80,
        branches: 80,
        "src/server/modules/policy/**": { lines: 80, branches: 80 },
        // A per-directory threshold on the E018 reseller module (T048): the subtree-membership gate + scoped
        // descent, the reseller repo (incl. the privileged subtree READ), the per-field branding resolver + locks
        // + trust-signal exclusion, the reseller lifecycle (onboard/suspend/offboard/move), the domain/email
        // verify state machine + one-binding-per-host, the dual-identity audit projection, and the routes must
        // each hold >=80% line+branch on their OWN, independent of the global rollup — the load-bearing isolation
        // (no-RLS-broadening) + dual-identity-audit evidence {SAD:ADR-0015} requires cannot be diluted.
        "src/server/modules/reseller/**": { lines: 80, branches: 80 },
      },
    },
  },
});
