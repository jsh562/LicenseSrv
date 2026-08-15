---
description: "Task list for feature implementation: Reseller and White-label Tenancy (E018)"
---

# Tasks: Reseller and White-label Tenancy

**Feature**: `00019-reseller-and-white-label-tenancy` | **Epic**: E018 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00019-reseller-and-white-label-tenancy/` (spec.md US1–US5 / FR-001..017 / SC-001..012 / Clarifications / Edge Cases / STF-001..007, plan.md AD-001..009 + HINT-001..005 + Requirement Coverage Map + Error Handling, data-model.md — migration `0014_reseller_branding.sql` + INV-1..INV-11 incl. the self-ref `tenant.parent_reseller_id`, the three new forced-RLS tables, the global one-binding-per-host partial-unique index, and the expand-only `audit_log.actor_reseller_id`, contracts/reseller-api.openapi.yaml — 20 admin operations over three actor planes + the enumerated 409 code set, checklists CHL001 Security / CHL002 Data Integrity / CHL003 API Quality — all passing, resolved amendments honored) and {SAD:ADR-0015} (reseller hierarchy + delegated cross-tenant administration).

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (config resolvers for default quota + grace window + trust-signal set + platform-default branding; the subtree-membership gate + scoped-descent logic; the per-field branding precedence + reseller-lock resolution + trust-signal exclusion; the suspend-cascade derivation; the domain/email verification state machine; the dual-identity audit projection shape), @testcontainers/postgresql integration (migration unset-GUC→0-rows + one-level CHECK + one-binding-per-host; downward-only visibility + cross-tenant 404 no-disclosure; reseller onboard/suspend/offboard/transfer; branding CRUD + resolution + locks; verify-before-activate; quota enforcement; RLS isolation across two resellers; dual-identity append-only audit), and a Security suite (explicit upward/lateral/IDOR escalation → 404 + security event + unset-GUC-0-rows; no reseller access to sub-tenant license/usage/activation operational data — FR-017; CSRF on every mutation) plus a ≥80% line+branch coverage gate on `src/server/modules/reseller/**`. Test tasks are enumerated TDD-first and precede (or accompany) the implementation they cover.

**Organization**: Grouped by user story (`US#`). US1/US2/US3 are P1 (the MVP gate); US4/US5 are P2. Nothing is deferred. Each story is an independently testable slice (Fastify `inject` + Testcontainers over an admin session; the subtree gate + branding resolver + verification driven directly; DNS verification results injected).

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E002/E005/E006/E016/E017) and the Postgres schema (migrations `0000`–`0013`). ADDITIVE / expand-only: one sequential migration `0014_reseller_branding.sql` (one self-ref `tenant.parent_reseller_id` column, one nullable `audit_log.actor_reseller_id` column, and three NEW tenant-owned forced-RLS tables — `reseller`, `branding_profile`, `domain_binding` — with the global one-binding-per-host partial-unique index; NO change to the per-tenant `tenant_isolation` predicate or any existing column) and one NEW module `src/server/modules/reseller/` registered at the seam AFTER `registerPolicy`. Cross-tenant reseller reach is confined to the existing audited `privileged` platform-admin seam (a subtree READ) and a scoped descent under the sub-tenant's OWN `app.current_tenant` (a reseller ACTION) — never a broadened RLS predicate (AD-001/002, HINT-001). Branding is presentation-only: it touches NO signer/verifier/token surface and performs NO cryptography (Principle I).

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Manage my own customers as a reseller | P1 🎯 MVP | GET/POST/GET `/admin/reseller/sub-tenants` (session+RBAC+CSRF) + subtree-membership gate + downward-only 404 (no disclosure) + hard-quota provisioning + metadata-only projection | a reseller lists/administers only its own two sub-tenants; a sibling/parent/platform id → 404 with no existence disclosure (SC-001/002); over-quota provision → 409 quota_exceeded (SC-008); a reseller-admin attempting an operator action → 403 + security event (US1-AS4); no license/usage/activation data ever exposed (FR-017) |
| US2 — Brand the experience for my customers | P1 🎯 MVP | GET/PUT reseller branding (+ per-field locks) + GET/PUT sub-tenant branding + the per-field precedence resolver + trust-signal exclusion + hierarchy-safe lock presentation | reseller branding shows by default, a sub-tenant override where set, a locked field is authoritative (409 field_locked) and shown "set by your provider" without revealing the hierarchy (SC-003/004/012); trust signals always authoritative (SC-006) |
| US3 — Keep every partner action isolated and audited | P1 🎯 MVP | data-layer escalation enforcement (upward/lateral/IDOR → 404 + security event; unset-GUC → 0 rows) + dual-identity append-only audit | no cross-subtree read/write is reachable at the data layer (SC-007); every reseller action records both the acting reseller-admin and the target sub-tenant, tamper-evident and un-editable (SC-005) |
| US4 — Onboard, suspend, and offboard a reseller safely | P2 | onboard (create-new OR promote-existing) + first admin + default quota + reversible suspend/read-only cascade + offboard transfer-or-reassign (no orphans) + operator-only move + last-owner protection | onboard both paths (409 onboarding_conflict); over-quota refused; suspend cascades read-only + reverses (SC-009); offboard blocked until every sub-tenant resolved (SC-010); operator-only move preserves overrides + re-resolves locks, audited both sides; last-owner protected (409 last_owner) |
| US5 — Use my own domain and email identity | P2 | initiate/list/get/verify/activate a `domain_binding`; DNS TXT/CNAME (domain) + SPF/DKIM/DMARC (email); verify→activate; one binding per host | activation refused until verified (409 not_verified); a host bound to another tenant is refused on both verify and activate (409 binding_conflict); verified domain resolves the correct tenant + branding (SC-011) |

**MVP gate**: US1 + US2 + US3 (all P1) — scoped downward-only reseller administration, per-field white-label branding, and provably isolated + dual-identity-audited partner actions — form a viable reseller core. US4 + US5 (P2) are in-scope, not deferred.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds sequential `0014_reseller_branding.sql` after `0013`; no change to `0000`–`0013`); `src/server/modules/index.ts` (registers the reseller seam AFTER `registerPolicy`); `src/server/config/index.ts` (adds reseller config keys — default sub-tenant quota, offboarding grace window, non-white-labelable trust-signal set, platform-default branding); `src/server/modules/admin/{routes.ts,users.ts}` (reseller onboarding + first-admin provisioning hooks; last-owner protection extended to reseller + sub-tenant tenants — minimal); `src/admin-ui/` (reseller console pages — Polish); `.github/workflows/` (adds `reseller.yml`, mirroring `usage.yml`/`policy.yml`); `vitest.config.ts` (coverage glob + gate).
- **Cross-epic reuse points (dependency seams)**: E002 tenancy `withTenant()`/`privileged` + forced RLS + GUC `app.current_tenant` → the subtree gate + scoped descent + the audited platform-admin subtree READ (FR-002/004/005, HINT-001); E005 console session + `rbac-middleware.ts` (`owner>admin>viewer`) + double-submit CSRF → all three actor planes (FR-002/016); E006 admin tenant/user/`audit_log` → onboarding create-or-promote + first-admin + last-owner + the append-only dual-identity audit trail (FR-001/009/016); E004 signer + E001 verifier → UNCHANGED, no crypto, no token change (Principle I, FR-011).
- **Patterns reused**: the `register<Module>` seam + `<Module>Error(code,status,details)` + `{code,message,details?}` error shape + per-module `config.ts`/`routes.ts`/`*-repo.ts` from E016/E017; the forced-RLS additive migration form; `withTenant()`/`privileged` as the sole RLS choke point; the `@testcontainers/postgresql` + admin-session integration harness; Zod request validation; camelCase wire ↔ snake_case column mapping.
- **Key constraints folded in**: the per-tenant `tenant_isolation` RLS predicate is NEVER broadened (subtree READ on the `privileged` seam filtered by `parent_reseller_id` after asserting caller ownership; a reseller ACTION descends into the sub-tenant's OWN scope — one audited gate, HINT-001); every out-of-subtree reference → 404 with NO existence disclosure + a `security_event` audit, never 403 (HINT-002); branding resolves PER FIELD (sub-tenant→reseller→platform) with reseller locks authoritative and presented "set by your provider" without revealing the hierarchy (HINT-003, STF-001/002/004); trust signals (revocation/tamper/security notices, signing identity, audit, legal text) are NEVER sourced from `branding_profile` (HINT-004, FR-008); suspend cascade + transfer are DERIVED not fanned out (HINT-005, AD-007); one binding per host is a global partial-unique index independent of RLS/GUC (INV-5); the dual-identity `actor_reseller_id` is stored independently of the mutable `parent_reseller_id` so attribution survives a transfer (INV-8); CSRF on every mutation; metadata-only reseller view of a sub-tenant (FR-017); presentation-only, no crypto/token change.
- **Regression focus**: the per-tenant forced-RLS predicate + append-only `audit_log` grants (SELECT,INSERT) keep working unchanged; the three new tables are additive + forced-RLS; the E004 signer / E001 verifier / LIC1 token bytes are untouched (already-issued tokens verify byte-identical, including under a reseller's read-only suspension); the admin plane = console session + RBAC (viewer reads; admin mutates) + double-submit CSRF (there is NO runtime / API-key plane and NO signing/crypto/token surface).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [X] T001 [P] Extend coverage globs for src/server/modules/reseller/** (≥80% line+branch) in vitest.config.ts
- [X] T002 {FR-003,FR-007,FR-008,FR-012} Reseller config keys (default sub-tenant quota; offboarding notice/grace window; non-white-labelable trust-signal set; platform-default branding) in src/server/config/index.ts
- [X] T003 Module scaffold: registerReseller seam + ResellerError + app.reseller (subtree gate seam) in src/server/modules/reseller/index.ts → exports: registerReseller, ResellerError(code,status,details)
- [X] T004 Register registerReseller after registerPolicy (end of MODULES) in src/server/modules/index.ts ← T003:registerReseller

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The migration `0014` (T008, verified by T009), the module scaffold + seam (Phase 1), and the shared building blocks — `config.ts` (default quota / grace window / trust-signal set / platform-default branding resolver), `reseller-repo.ts` (reseller CRUD + status/quota + parent link + the privileged subtree READ), `gate.ts` (subtree-membership gate + scoped descent + downward-only 404), and `audit.ts` (the dual-identity projection) — block every delivery story (US1 administration, US2 branding, US3 isolation/audit, US4 lifecycle, US5 verification all compose them). Complete before any US phase. The unit tests (T005–T007) are TDD-first and precede their implementations; the migration integration test (T009) verifies the finalized DDL. The gate + migration tests carry the load-bearing isolation evidence (unset-GUC-0-rows, one-level CHECK, one-binding-per-host) HINT-001/002 require.**

- [X] T005 [P] Unit (TDD): config resolvers — default sub-tenant quota, offboarding grace window, trust-signal set, platform-default branding in src/server/modules/reseller/__tests__/config.unit.test.ts
- [X] T006 [P] Unit (TDD): subtree-membership gate + scoped-descent decision + downward-only 404 (no disclosure) logic (pure) in src/server/modules/reseller/__tests__/gate.unit.test.ts
- [X] T007 [P] Unit (TDD): dual-identity audit projection shape — tenant_id=target, actor=reseller-admin, actor_reseller_id=acting reseller (INV-8) in src/server/modules/reseller/__tests__/audit.unit.test.ts
- [X] T008 Migration 0014: tenant.parent_reseller_id self-ref FK + CHECK(<>id) + partial idx; reseller + branding_profile + domain_binding (forced RLS, grants, indexes, global one-binding-per-host partial-unique WHERE status IN verified|active); audit_log.actor_reseller_id in migrations/0014_reseller_branding.sql
- [X] T009 [P] Migration IT (TDD): unset-GUC→0-rows on all three new tables; one-level CHECK(<>id); one-binding-per-host partial-unique (many pending, ≤1 verified/active) in src/server/modules/reseller/__tests__/migration.integration.test.ts after:T008
- [X] T010 {FR-003,FR-008} Config resolver — default quota + grace window + trust-signal set + platform-default branding in src/server/modules/reseller/config.ts → exports: ResellerConfig after:T002
- [X] T011 Reseller repo: reseller CRUD + status/quota + parent_reseller_id link + subtree list (privileged seam, ownership-asserted) via withTenant/privileged in src/server/modules/reseller/reseller-repo.ts → exports: ResellerRepo after:T008
- [X] T012 {FR-002,FR-004,FR-005} Subtree-membership gate + scoped descent (assert ownership → operate under sub-tenant scope) + downward-only 404 no-disclosure in src/server/modules/reseller/gate.ts ← T011:ResellerRepo → exports: assertSubtreeMembership, withSubTenantScope after:T011
- [X] T013 {FR-009} Dual-identity audit projection (actor reseller-admin + target sub-tenant + actor_reseller_id) over append-only audit_log in src/server/modules/reseller/audit.ts → exports: writeResellerAudit after:T008

---

## Phase 3: US1 — Manage my own customers as a reseller (Priority: P1) 🎯 MVP

**Independent test**: seed a reseller with sub-tenants A and B plus an unrelated sibling reseller; the reseller-admin lists and administers only A and B (SC-001); a reference to the sibling's customer, a parent, or the platform resolves 404 with no existence disclosure (SC-002); provisioning within quota creates an immediately-administrable sub-tenant, and at the hard cap → 409 quota_exceeded (SC-008); an action reserved for the operator (e.g. move) attempted by a reseller-admin → 403 + security event (US1-AS4); no license/usage/activation data of any sub-tenant is ever returned (FR-017).

- [X] T014 [P] [US1] {FR-002,FR-004} IT (TDD): list/get own sub-tenants (metadata only); sibling/parent/platform id → 404 no disclosure; unset-GUC → 0 rows (SC-001/002) in src/server/modules/reseller/__tests__/subtenants.integration.test.ts
- [X] T015 [P] [US1] {FR-002,FR-003} IT (TDD): provision under hard quota; over-quota → 409 quota_exceeded; reseller-admin attempting an operator action → 403 + security event (SC-008, US1-AS4) in src/server/modules/reseller/__tests__/provision.integration.test.ts
- [X] T016 [P] [US1] {FR-017} IT (TDD): metadata-only — no license/usage/activation field in any sub-tenant response/list/repo projection (SC-001) in src/server/modules/reseller/__tests__/metadata-only.integration.test.ts
- [X] T017 [US1] {FR-002} [COMPLETES FR-002] Reseller plane + RBAC (reseller-admin = admin/owner of a reseller tenant) fail-closed + whole-subtree authority wired into routes in src/server/modules/reseller/routes.ts ← T012:assertSubtreeMembership after:T012
- [X] T018 [US1] {FR-004} [COMPLETES FR-004] Routes: GET list + GET detail own sub-tenants; out-of-subtree → 404 no disclosure + security event in src/server/modules/reseller/routes.ts ← T012:assertSubtreeMembership after:T017
- [X] T019 [US1] {FR-003} [COMPLETES FR-003] Provision sub-tenant under the hard quota (409 quota_exceeded) in src/server/modules/reseller/lifecycle.ts + routes.ts ← T011:ResellerRepo after:T018 → exports: provisionSubTenant
- [X] T020 [US1] {FR-017} [COMPLETES FR-017] Metadata-only projection (display name/status/branding-context only; no license/usage/activation) in src/server/modules/reseller/reseller-repo.ts + routes.ts after:T019

---

## Phase 4: US2 — Brand the experience for my customers (Priority: P1) 🎯 MVP

**Independent test**: configure reseller branding with a locked field and one sub-tenant override; a customer sees the reseller brand by default (SC-003) and its override where set, while the locked field stays authoritative — a sub-tenant override of it is refused 409 field_locked and it is shown "set by your provider" without revealing the reseller (SC-004/012); each of the 8 fields resolves independently by precedence sub-tenant→reseller→platform (SC-004); a revocation/tamper/security notice, signing identity, audit record, or legal text is always shown authoritatively regardless of branding (SC-006).

- [X] T021 [P] [US2] {FR-006,FR-007,FR-008} Unit (TDD): per-field precedence (sub-tenant→reseller→platform) + reseller locks win + trust-signal exclusion from resolution in src/server/modules/reseller/__tests__/branding.unit.test.ts
- [X] T022 [P] [US2] {FR-006,FR-007} IT (TDD): reseller branding CRUD + per-field locks; sub-tenant override; locked-field override → 409 field_locked; resolved per field (SC-003/004) in src/server/modules/reseller/__tests__/branding.integration.test.ts
- [X] T023 [P] [US2] {FR-008,FR-014} IT (TDD): locked field shown "set by your provider" without disclosing the hierarchy; trust signals always authoritative (SC-006/012) in src/server/modules/reseller/__tests__/branding-hierarchy.integration.test.ts
- [X] T024 [US2] {FR-006} branding_profile CRUD + per-field locked flags + hierarchy-safe lock presentation in src/server/modules/reseller/branding.ts ← T010:ResellerConfig → exports: BrandingRepo, resolveBranding after:T013
- [X] T025 [US2] {FR-007} [COMPLETES FR-007] Per-field precedence resolver (each of the 8 fields independent; locks authoritative; active-binding gate for domain/email) in src/server/modules/reseller/branding.ts after:T024
- [X] T026 [US2] {FR-008} [COMPLETES FR-008] Trust-signal exclusion — resolver never sources revocation/signing/audit/legal from branding_profile in src/server/modules/reseller/branding.ts after:T025
- [X] T027 [US2] {FR-006} [COMPLETES FR-006] Routes: GET/PUT reseller branding (+locks) + GET/PUT sub-tenant branding (409 field_locked / not_verified) in src/server/modules/reseller/routes.ts ← T024:resolveBranding after:T026
- [X] T028 [US2] {FR-014} [COMPLETES FR-014] Sub-tenant experience unchanged bar applied branding; hierarchy hidden (no other tenant, no reseller disclosure) in src/server/modules/reseller/branding.ts + routes.ts after:T027

---

## Phase 5: US3 — Keep every partner action isolated and audited (Priority: P1) 🎯 MVP

**Independent test**: drive actions across two resellers and confirm no cross-subtree read/write is reachable at the data layer — an upward (parent/platform), lateral (sibling), or IDOR-by-id attempt returns 404 with no disclosure + a security event, and an unset tenant GUC yields zero rows (SC-007); every reseller action on a sub-tenant produces one append-only audit row carrying both the acting reseller-admin and the target sub-tenant, and no role — including owner and reseller-admin — can edit or delete it (SC-005).

- [X] T029 [P] [US3] {FR-005} IT (TDD): upward/lateral/IDOR escalation → 404 no disclosure + security event; unset-GUC → 0 rows at the data layer (SC-002/007) in src/server/modules/reseller/__tests__/isolation-escalation.integration.test.ts
- [X] T030 [P] [US3] {FR-009} IT (TDD): dual-identity audit on every reseller action (actor + actor_reseller_id + target); append-only, edit/delete refused for all roles (SC-005) in src/server/modules/reseller/__tests__/audit.integration.test.ts
- [X] T031 [US3] {FR-005} [COMPLETES FR-005] Enforce no upward/lateral escalation at the data-access layer (no RLS broadening; privileged seam + scoped descent) + security-event audit in src/server/modules/reseller/gate.ts after:T012
- [X] T032 [US3] {FR-009} [COMPLETES FR-009] Wire dual-identity append-only audit into every reseller mutation and every denied escalation in src/server/modules/reseller/audit.ts + routes.ts ← T013:writeResellerAudit after:T031

---

## Phase 6: US4 — Onboard, suspend, and offboard a reseller safely (Priority: P2)

**Independent test**: onboard a reseller by creating a new tenant OR promoting an existing one (a tenant already a reseller/sub-tenant → 409 onboarding_conflict), establishing the first reseller-admin and the platform-default quota; exceed the quota (refused); suspend it and confirm the read-only cascade (a sub-tenant mutation → 409 reseller_suspended) while issued licenses keep verifying offline, then reinstate (SC-009); attempt offboarding with unresolved sub-tenants (409 sub_tenants_unresolved) then resolve every sub-tenant by transfer/reassign (no orphans, each move audited on source + destination) (SC-010); confirm only the operator may move a sub-tenant and last-owner removal is refused (409 last_owner).

- [X] T033 [P] [US4] {FR-001,FR-010} IT (TDD): onboard create-new OR promote-existing + first admin + default quota; already-reseller/already-sub-tenant → 409 onboarding_conflict in src/server/modules/reseller/__tests__/onboard.integration.test.ts
- [X] T034 [P] [US4] {FR-011} IT (TDD): suspend → read-only cascade (409 reseller_suspended) + reinstate restores; issued licenses verify offline unchanged (SC-009) in src/server/modules/reseller/__tests__/suspend.integration.test.ts
- [X] T035 [P] [US4] {FR-012} IT (TDD): offboard blocked (409 sub_tenants_unresolved) until every sub-tenant resolved; grace window; resolution audited (SC-010) in src/server/modules/reseller/__tests__/offboard.integration.test.ts
- [X] T036 [P] [US4] {FR-015,FR-016} IT (TDD): operator-only move re-points parent + preserves overrides + re-resolves locks + dual audit; last-owner removal → 409 last_owner in src/server/modules/reseller/__tests__/move-lastowner.integration.test.ts
- [X] T037 [US4] {FR-001} [COMPLETES FR-001] Onboard create-or-promote (one-level rule) + first-admin hook in src/server/modules/reseller/lifecycle.ts + src/server/modules/admin/{routes.ts,users.ts} ← T011:ResellerRepo after:T032
- [X] T038 [US4] {FR-010} [COMPLETES FR-010] Onboarding establishes reseller + first reseller-admin + platform-default quota in src/server/modules/reseller/lifecycle.ts + routes.ts ← T010:ResellerConfig after:T037
- [X] T039 [US4] {FR-011} [COMPLETES FR-011] Suspend/reinstate + derived read-only cascade (409 reseller_suspended; no fan-out write) in src/server/modules/reseller/lifecycle.ts + gate.ts after:T038
- [X] T040 [US4] {FR-012} [COMPLETES FR-012] Offboard transfer-or-reassign (no orphans) + notice/grace window + audited; idempotent progress in src/server/modules/reseller/lifecycle.ts + routes.ts after:T039
- [X] T041 [US4] {FR-015} [COMPLETES FR-015] Operator-only move: re-point parent, keep overrides, re-resolve locks to destination, dual audit source+dest in src/server/modules/reseller/lifecycle.ts + branding.ts ← T024:resolveBranding after:T040
- [X] T042 [US4] {FR-016} [COMPLETES FR-016] Last-owner protection for reseller + sub-tenant tenants (409 last_owner) in src/server/modules/admin/users.ts after:T037
- [X] T051 [P] [US4] {FR-003} IT (TDD): operator quota-update — only the operator may raise/lower a reseller's quota (reseller-plane attempt → 403 security event); lowering below current sub-tenant count is refused; over-cap provisioning still blocked; operator reseller list/get deterministic + bounded in src/server/modules/reseller/__tests__/operator-reseller.integration.test.ts
- [X] T052 [US4] {FR-003} Operator-plane routes: PATCH /admin/operator/resellers/{id}/quota (operator-only + CSRF + audited) + GET list/detail resellers (deterministic, bounded, truncated) in src/server/modules/reseller/routes.ts after:T038

---

## Phase 7: US5 — Use my own domain and email identity (Priority: P2)

**Independent test**: initiate verification for a custom domain (DNS TXT/CNAME) and an email sender (SPF + DKIM/DMARC), attempt to activate before verification (409 not_verified), verify then activate (pending→verified→active), and confirm a verified domain resolves the correct tenant and applies its branding (SC-011); a host already bound (verified/active) to another tenant is refused on both verify and activate (409 binding_conflict) with no cross-tenant disclosure.

- [X] T043 [P] [US5] {FR-013} Unit (TDD): verification state machine (pending→verified→active) + method-per-type (domain TXT/CNAME; email SPF/DKIM/DMARC) + host normalization in src/server/modules/reseller/__tests__/verify.unit.test.ts
- [X] T044 [P] [US5] {FR-013} IT (TDD): initiate/verify/activate; verify-before-activate (409 not_verified); one-binding-per-host (409 binding_conflict) on verify AND activate (SC-011) in src/server/modules/reseller/__tests__/verify.integration.test.ts
- [X] T045 [US5] {FR-013} Domain (TXT/CNAME) + email (SPF/DKIM/DMARC) verification + state machine + one-binding-per-host (injected DNS result) in src/server/modules/reseller/verify.ts ← T011:ResellerRepo → exports: DomainVerifier after:T011
- [X] T046 [US5] {FR-013} [COMPLETES FR-013] Routes: initiate/list/get/verify/activate domain bindings; verify→activate; 409 binding_conflict/not_verified in src/server/modules/reseller/routes.ts ← T045:DomainVerifier after:T045

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T047 Finalize double-submit CSRF + RBAC/plane 403 on every mutation across all three planes; audit each denial as a security event in src/server/modules/reseller/routes.ts after:T046
- [X] T048 Enforce ≥80% line+branch coverage of src/server/modules/reseller/** in vitest.config.ts after:T047
- [X] T049 [P] Reseller CI (typecheck+lint, Testcontainers IT+coverage, npm audit, semgrep; SHA-pinned actions) in .github/workflows/reseller.yml mirroring usage.yml
- [X] T050 [P] Reseller admin-ui pages: operator reseller mgmt + sub-tenant mgmt + branding editor (per-field + locks) + domain/email verify in src/admin-ui/src/pages/reseller/index.tsx after:T046

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → Polish (Phase 8)

- **Phase 1 (Setup)** has no dependencies. T002 adds the config keys the `config.ts` resolver (T010) reads live. T003 (scaffold: `registerReseller` + `ResellerError` + `app.reseller` seam) + T004 (seam registration, needs T003's `registerReseller`) wire the module after `registerPolicy`.
- **Phase 2 (Foundational)** depends on Setup. The migration `0014` (T008) is a single sequential file (self-ref `tenant.parent_reseller_id` + CHECK + partial idx; the three new forced-RLS tables incl. the global one-binding-per-host partial-unique; the expand-only `audit_log.actor_reseller_id`). The unit tests T005–T007 precede their implementations (TDD-first). `config.ts` (T010), `reseller-repo.ts` (T011, incl. the privileged subtree READ), `gate.ts` (T012, the subtree gate + scoped descent, composing `ResellerRepo`), and `audit.ts` (T013, the dual-identity projection) are the cross-story blockers every US phase composes. T009 verifies the migration (after:T008).
- **US1 (P1)** composes the gate + repo: `routes.ts` is created here (T017 plane/RBAC → T018 list/detail downward-only 404 → T019 provision-under-quota → T020 metadata-only projection). FR-002 completes at T017, FR-004 at T018, FR-003 at T019, FR-017 at T020.
- **US2 (P1)** builds `branding.ts` (T024 CRUD+locks → T025 per-field precedence resolver → T026 trust-signal exclusion → T028 hierarchy-safe sub-tenant experience) and wires the branding routes (T027, ← T024 `resolveBranding`). FR-007 completes at T025, FR-008 at T026, FR-006 at T027, FR-014 at T028.
- **US3 (P1)** hardens `gate.ts` for data-layer escalation prevention (T031, after:T012, completes FR-005) and wires the dual-identity append-only audit into every mutation + denial (T032, ← T013 `writeResellerAudit`, completes FR-009).
- **US4 (P2)** builds the reseller lifecycle in `lifecycle.ts` (T037 onboard create-or-promote → T038 establish reseller+admin+quota → T039 suspend/reinstate cascade → T040 offboard transfer-or-reassign → T041 operator-only move) plus last-owner protection in the reused user-admin surface (T042, after:T037). FR-001 completes at T037, FR-010 at T038, FR-011 at T039, FR-012 at T040, FR-015 at T041, FR-016 at T042. T039 also extends `gate.ts` (derived read-only cascade); T041 also re-resolves locks via `branding.ts` (← T024 `resolveBranding`).
- **US5 (P2)** builds `verify.ts` (T045, the DNS verification state machine + one-binding-per-host, ← T011 `ResellerRepo`) and the domain routes (T046, ← T045 `DomainVerifier`, completes FR-013).
- **Polish (Phase 8)** depends on the delivery routes/handlers: CSRF/RBAC finalize (T047, after:T046), the coverage gate (T048, after:T047), CI (T049), and the admin-ui pages (T050, after:T046).
- **Shared same-file chains** (all sequential, never `[P]` together): `migrations/0014_reseller_branding.sql` (T008); `gate.ts` (T012→T031→T039); `audit.ts` (T013→T032); `branding.ts` (T024→T025→T026→T028→T041); `lifecycle.ts` (T019→T037→T038→T039→T040→T041); `reseller-repo.ts` (T011→T020); `routes.ts` (T017→T018→T019→T020→T027→T028→T032→T038→T040→T046→T047); `modules/admin/users.ts` (T037→T042); `config/index.ts` (T002); `config.ts` (T010); `verify.ts` (T045); `vitest.config.ts` (T001→T048).
- Tasks marked `[P]` are parallelizable within their phase (distinct files, no intra-batch dependency). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references. All same-file edits are sequential.

## Delivery Notes

- **Isolation is the crux (AD-001/002, HINT-001, INV-1/2)**: `gate.ts` (T012/T031) NEVER broadens the per-tenant `tenant_isolation` predicate. A reseller subtree READ runs on the `privileged` seam `WHERE parent_reseller_id = :reseller` AFTER asserting the caller owns that reseller; a reseller ACTION descends into the sub-tenant's OWN `app.current_tenant` via `withTenant`. The migration IT (T009) proves unset-GUC → 0 rows on all three new tables, and the escalation IT (T029) proves upward/lateral/IDOR → 404 (no disclosure) + a `security_event` audit — never 403 (403 leaks existence, HINT-002).
- **Branding per-field + locks + trust exclusion (AD-004/005, HINT-003/004, STF-001/002/004)**: `branding.ts` resolves each of the 8 `BrandingFieldName` fields independently (sub-tenant→reseller→platform), computed at read never stored (no drift); a reseller-locked field ignores any sub-tenant override (409 field_locked) and is presented "set by your provider" without revealing the hierarchy; `emailSenderAddress`/`customDomain` take effect only once a matching `domain_binding` is `active`; trust signals are never sourced from `branding_profile` (FR-008).
- **Dual-identity, append-only audit (AD-008, INV-8)**: every reseller action writes ONE `audit_log` row under the sub-tenant (target) scope carrying `actor`=reseller-admin + `actor_reseller_id`=the acting reseller's home tenant (stored independently of the mutable `parent_reseller_id`, so attribution survives a transfer); denied escalations set `security_event=true`; `audit_log` keeps SELECT,INSERT only (no role edits/deletes).
- **Lifecycle governance (AD-003/007, HINT-005)**: onboarding is one create-or-select flow (create-new OR promote-existing, one-level rule → 409 onboarding_conflict); the quota is a hard cap only the operator changes; suspend cascades a DERIVED read-only state (no fan-out write, reversible, issued licenses verify offline); offboard is blocked until every sub-tenant is transferred/reassigned (no orphans, grace window, audited); a move re-points `parent_reseller_id`, keeps overrides, re-resolves locks to the destination, and audits both sides; last-owner protection covers reseller + sub-tenant.
- **Verify-before-activate + one-binding-per-host (AD-006, INV-5/6)**: `verify.ts` (T045) proves a domain via TXT/CNAME and an email sender via SPF+DKIM/DMARC alignment before activation (409 not_verified); the global partial-unique `(binding_type,host) WHERE status IN ('verified','active')` guarantees ≤1 bound binding per host across all tenants independent of RLS — a losing verify/activate → 409 binding_conflict with no cross-tenant disclosure (the challenge token is a PUBLIC DNS value, never a secret).
- **Presentation-only, no crypto (Principle I, INV-9)**: nothing here touches the E004 signer or E001 verifier; branding never alters a license's contents or the signed token; already-issued licenses verify offline unchanged, including under a reseller's read-only suspension cascade.
- **Tests**: integration suites use `@testcontainers/postgresql` reusing the admin-session harness; DNS verification results are injected; the unit tier drives the config resolvers, the gate/scoped-descent logic, the branding precedence + lock + trust-exclusion resolver, and the verification state machine.
- No deferred work within the epic: US4/US5 (P2) are fully in-scope; the MVP gate is US1 + US2 + US3. Nested/multi-level reseller hierarchies, reseller billing, reseller-keyed signing, partner self-signup, and per-reseller custom code remain out of scope per the spec Excluded set.

## Requirement Coverage

| Req | Tasks | Completing task |
|-----|-------|-----------------|
| FR-001 | T033, T037 | T037 |
| FR-002 | T012, T014, T015, T017 | T017 |
| FR-003 | T002, T015, T019, T051, T052 | T019 |
| FR-004 | T012, T014, T018 | T018 |
| FR-005 | T006, T009, T012, T029, T031 | T031 |
| FR-006 | T021, T022, T024, T027 | T027 |
| FR-007 | T002, T021, T022, T024, T025 | T025 |
| FR-008 | T002, T021, T023, T026 | T026 |
| FR-009 | T007, T013, T030, T032 | T032 |
| FR-010 | T033, T038 | T038 |
| FR-011 | T034, T039 | T039 |
| FR-012 | T002, T035, T040 | T040 |
| FR-013 | T043, T044, T045, T046 | T046 |
| FR-014 | T023, T028 | T028 |
| FR-015 | T036, T041 | T041 |
| FR-016 | T036, T042 | T042 |
| FR-017 | T016, T020 | T020 |

**Rollup**: 17/17 functional requirements covered (FR-001..FR-017), each with exactly one `[COMPLETES FR-###]` marker. 12 success criteria exercised — SC-001/002 (US1), SC-003/004/006 (US2), SC-005/007/012 (US3), SC-008/009/010 (US1+US4), SC-011 (US5). 3 new forced-RLS tables (`reseller`, `branding_profile`, `domain_binding`) + a self-ref `tenant.parent_reseller_id` + a nullable `audit_log.actor_reseller_id` via one migration `0014_reseller_branding.sql`; 20 admin operations across three actor planes (7 operator lifecycle + move, 3 reseller sub-tenant, 2 reseller branding + sub-tenant branding, 5 reseller domain) — onboarding + last-owner reuse the E006 user-admin surface. P1 (US1–US3) forms a viable MVP; US4/US5 (P2) are in-scope, not deferred; no coverage gaps.
