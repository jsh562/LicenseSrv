# Implement + QC Loop — E006

## Iteration 1 (Setup → OBJ1–6 + docs/CI; OBJ7 deferred)
- Delivered: config loader + `<VAR>_FILE` secrets; entrypoint (`main.ts` buildServer/startServer); health probes
  (live/ready/startup, DB + composed signer readiness); migrate CLI on the shared config contract; Dockerfile
  (multi-stage, non-root, serve/migrate); .dockerignore; docker-compose (gated migrate + ordering + healthchecks);
  .env.example; config reference + 2 runbooks; README; CI workflow (runtime.yml).
- Bugs fixed in-loop: (1) `.min(1, msg)` didn't fire on undefined → added Zod `required_error` so fail-fast names
  the env var; (2) health DB-down test leaked an unhandled pool error when stopping the shared container → switched
  to an unreachable throwaway pool; (3) `port` schema rejected 0 → allow OS-ephemeral; (4) readiness composed the
  signer unconditionally (locked keystore → perpetually not-ready) → decorate `signerReady` only when custodian
  shares are configured (OR-013 "where a signer is configured").
- Tests: full server suite 102 pass / 3 skipped; coverage 93.3% line / 82.2% branch / 97.6% func (≥80). Typecheck + lint clean.
- QC: QC Auditor PASS (all runnable gates); Story Verifier PASS (OBJ1–6; SC-001/004/008 CI-VALIDATED image execution).
- Environment limitation: Docker image build + compose smoke could NOT run locally (Docker build namespace has no npm
  registry egress). CI-gated in runtime.yml (DOCKER_SMOKE=1), like semgrep. Not a defect.
- Deferred: OBJ7 graceful-shutdown window + drain test (T023/T024, P2).
- Verdict: **PASS (with deferred P2 + CI-gated image smoke)**. Artifacts: .completed ✓, qc-report.md ✓, .qc-passed ✓.
