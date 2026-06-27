<!-- template-version: 2 -->
# LicenseSrv Project Instructions

## Core Principles

<!-- 3–7 non-negotiable principles. Each: succinct name, MUST/SHOULD rule, rationale. -->

### I. Offline-First Cryptographic Verification

License verification MUST succeed without any network call, using Ed25519 signatures checked against a pinned public keyring; private signing keys MUST never leave a KMS/HSM or an encrypted keystore. — Enables air-gapped and on-prem deployment with near-zero verification latency, and keeps the only forgery vector (the signing key) under hardware-grade custody.

### II. Multi-Tenant Isolation

Every persistence and API operation MUST be scoped to an authenticated tenant and gated by role-based access control; no operation may read or mutate another tenant's data without an explicit, audited platform-admin action. — The product is multi-tenant SaaS from day one, and a single cross-tenant leak is catastrophic and unrecoverable.

### III. Single Security Core, Fully Audited

All cryptographic verification MUST be implemented once in the Rust verifier core and reused across every language binding (no per-language reimplementation of crypto), and every license and administrative mutation MUST be written to an append-only audit log. — Re-implemented crypto is the primary source of licensing CVEs, and auditability is required for forensics, compliance, and tamper-evidence.

### IV. Agent Output Style

All agent output MUST be concise and outcome-oriented. This principle supersedes any verbose defaults.

- **Progress reports**: Facts and outcomes only — no narration, no restating the task.
- **Artifacts**: Emit required sections only — no preamble paragraphs, no summary epilogues.
- **Reasoning**: Omit unless the user asks "why" or the decision is non-obvious.
- **Errors / blockers**: State the problem, the attempted fix, and the result — nothing else.
- **Phase-boundary reports**: ≤ 5 bullet points.
- **Preserve without compressing**: Artifact template structure and required sections; explicit decision / registration / validation guidance in shared skills; delegation constraints and sub-agent role definitions; existing size limits (spec ≤ 1000 KB, research ≤ 400 KB, stories ≤ 200 words).

## Technology Stack

<!-- Downstream phases (Plan, QC, Autopilot) read this section as the authoritative tech-stack reference. -->

- **Language/Runtime**: TypeScript 5.x / Node 22 (license server + admin API); Rust (stable toolchain) for the embeddable verifier core. Migration of the server to Rust is a planned future phase; the verifier core is Rust from day one.
- **Frameworks**: Server — Fastify (HTTP), Drizzle ORM (Postgres access), Zod (validation). Admin UI — React + Vite (TypeScript SPA). Verifier core — Rust with `ed25519-dalek` (signatures) and `ciborium` (CBOR), exposed via C ABI (`cbindgen`), WASM (`wasm-pack`), and UniFFI-generated bindings.
- **Storage**: PostgreSQL 16 (primary, tenant-scoped store). Redis 7 reserved for later phases (rate-limit counters, floating-seat leases).
- **Infrastructure**: Docker; ships as one signed multi-arch container image that runs self-hosted (including air-gapped) or as a managed multi-tenant SaaS — **self-host-first and cloud-agnostic, with no mandatory cloud dependency**. Signing keys held via a pluggable signer: encrypted-keystore / soft-HSM default, with optional cloud KMS / HSM (PKCS#11) adapters; never in application memory as plaintext. (See `specs/dod.md` DDR-001, DDR-003.)

## Testing & Quality Policy

<!-- QC extracts enforcement rules from this section. Use the keywords below so automated checks activate correctly. -->
<!-- Keywords recognised by QC: lint, static analysis, code quality, coverage, security, vulnerability, OWASP, WCAG, accessibility, benchmark, performance -->

- **Coverage Target**: 80% (license server and verifier core).
- **Required QC Categories**: linting, security scanning, coverage, performance. Security scanning MUST run dependency audit (`npm audit`, `cargo audit`), SAST (Semgrep), and image/supply-chain scanning (Trivy + Grype, gating HIGH/CRITICAL — owned by the Deployment & Operations document); the verifier-core token parser MUST be fuzzed (`cargo-fuzz`).
- **Test Strategy**: Unit + integration; E2E for critical paths (license issuance, offline verification, activation accounting, air-gapped activation file flow). Cryptographic verification and tenant-isolation paths are test-first (red-green-refactor). Ed25519 verification latency MUST be benchmarked (`criterion`).
- **Linting / Formatting**: ESLint + Prettier (TypeScript, strict; `tsconfig` `strict: true`); Clippy + rustfmt (Rust, `-D warnings`).

## Source Code Layout

- **Policy**: ENFORCE_SRC_ROOT
- **Convention**: Project source code MUST live under `/src`. Layout: `/src/verifier-core` (Rust core + `fuzz/`), `/src/bindings/{c-abi,wasm,uniffi}` (language bindings), `/src/server` (Node/TS API + token signing + Postgres access), `/src/admin-ui` (React SPA). TypeScript tests co-located in `__tests__/`; Rust tests in `#[cfg(test)]` modules and `tests/`. Config and manifests at repo root and per-package roots.

## Development Workflow

- **Branching**: Feature branches from `main` named `#####-feature-name` (e.g. `00001-license-server`); squash merge. (Repo is not yet git-initialized; until then, Feature Workspaces use `specs/00001-feature-name`.)
- **Commit Convention**: Conventional Commits.
- **CI Requirements**: Before merge — all tests pass, lint clean, no TypeScript type errors, security scan clean, coverage ≥ target.

## Security Requirements

- Private signing keys MUST be generated and held in KMS/HSM or an encrypted keystore; never logged, never returned by any API.
- Signing keys are versioned (`key_id`) and rotatable; clients trust a keyring (multiple public keys), never a single hard-coded key.
- Machine fingerprints and customer identifiers MUST be stored as salted hashes or minimized; PII collection MUST be justified, retention-bounded, and deletable (GDPR).
- All activation/validation/heartbeat endpoints MUST be rate-limited; activation requests MUST carry nonces and usage reports idempotency keys (anti-replay).

## Governance

- Project instructions supersede all other documentation and practices.
- Amendments require a version bump with an ISO-dated changelog entry.
- All implementations MUST pass the Instructions Check gate during planning.
- Complexity beyond these principles MUST be justified and documented.
- Any violation of these project instructions is CRITICAL severity.

## Changelog

- **1.1.0** (2026-06-26): Reconciled Infrastructure posture to self-host-first / cloud-agnostic with a pluggable signer (encrypted-keystore/soft-HSM default, optional cloud KMS) to align with `specs/sad.md` and `specs/dod.md` (DDR-001, DDR-003); expanded the security-scanning toolchain to include image/supply-chain scanning (Trivy + Grype) alongside dependency audit and SAST.
- **1.0.0** (2026-06-26): Initial project instructions (principles, technology stack, testing/quality policy, source layout, workflow, governance).

**Version**: 1.1.0 | **Last Amended**: 2026-06-26
