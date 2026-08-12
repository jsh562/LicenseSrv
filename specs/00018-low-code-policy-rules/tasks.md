---
description: "Task list for feature implementation: Low-Code Policy Rules (E017)"
---

# Tasks: Low-Code Policy Rules

**Feature**: `00018-low-code-policy-rules` | **Epic**: E017 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Input**: Design documents from `specs/00018-low-code-policy-rules/` (spec.md US1–US6 / FR-001..021 / SC-001..020 / Clarifications / STF-001 / Edge Cases, plan.md AD-001..009 + HINT-001..005 + Requirement Coverage Map + Error Handling, data-model.md — migration `0013_policy_rules.sql` + INV-1..INV-12 incl. the new `considered_rules` column + INV-12 canonical hash + config-sourced audit retention, contracts/policy-api.openapi.yaml — 6 admin endpoints + codes `rule_set_limit_exceeded`/`invalid_state_transition`, checklists CHL001 Security / CHL002 Data Integrity / CHL003 API Quality) and ADR-0014 (sandboxed policy-rule engine + issuance-time bounded-effect model).

**Tests**: Included — the plan Testing Strategy mandates Vitest unit (config resolvers for eval timeout + JSON size/AST-depth/complexity caps + per-tenant rule-set/per-issuance cost caps + absolute authored-max cap + retention window + conflict policy; the SANDBOXED allow-listed JSONLogic-subset evaluator — no-eval/escape, determinism/re-eval, resource-bound timeout/depth; the closed typed effect applier — clamp to authored max / rule-eligible boolean / plan-defined tier; author-time validation distinct codes; context-builder minimization + has()-guard + canonical serialization/hash; highest-priority-wins one-effect + tiebreak + considered-not-applied), @testcontainers/postgresql integration (rule CRUD + immutable versioning + status + 409 invalid_state_transition; UPDATE-restricted-to-status repo guard; adjust-decision-at-issuance + clamp; fail-closed on error/timeout/bound/per-decision-cap; audit-write-failure fails closed; sandbox-escape; dry-run/preview no-enforce + supplied-context bounding; conflict precedence; catalog authored-max governance; RLS isolation; append-only mode-marked audit; retention prune; secret/PII), a Security suite (no arbitrary code / host / I-O reachable from a rule; no secret/key/PII anywhere; effect never exceeds the authored max — SC-005/013/015) and a ≥80% line+branch coverage gate on `src/server/modules/policy/**`. Evaluation is driven deterministically via the injected decision timestamp. Test tasks are enumerated and precede their implementation (TDD).

**Organization**: Grouped by user story (`US#`). US1/US2/US3 are P1 (the MVP gate); US4/US5/US6 are P2. Nothing is deferred. Each story is an independently testable slice (Fastify `inject` + Testcontainers; the issuance seam driven directly; the injected clock making evaluation deterministic).

## Project Mode

`Brownfield` — extends the existing Node/TypeScript modular monolith (`src/server/`, E004/E005/E007/E008/E013/E014/E015/E016) and the Postgres schema (migrations `0000`–`0012`). ADDITIVE / expand-only: one sequential migration `0013_policy_rules.sql` (two new tenant-owned tables — `policy_rule` immutably-versioned forced-RLS, `policy_evaluation` unified mode-marked append-only forced-RLS with the new `considered_rules` column + canonical `input_hash` + BRIN retention — plus an expand-only `rule_max`/`rule_eligible`/`rule_tiers` extension of the E007 `entitlement`; NO change to any existing column or the E007 boolean/integer_limit/metered semantics) and one NEW module `src/server/modules/policy/` registered at the seam AFTER `registerUsage`. The engine runs ONLY on the E008 issuance/signing path (post-processing `getEffectivePlanDefinition` BEFORE the E004 signer runs), never in the E001 verifier core, changing no token bytes and performing NO cryptography.

## Epic / Capability Map

| Work Item | Priority | Slice | Independently Testable |
|-----------|----------|-------|------------------------|
| US1 — Author and validate a guarded rule | P1 🎯 MVP | POST/GET/PATCH `/admin/policy/rules` (session+RBAC+CSRF) + author-time validate-before-persist (shape + operator allow-list + context type-check + effect-bounds + rule-set size cap → distinct 400 codes) + the catalog authored-maximum governance action | author a well-formed rule → saved; unsafe/host-access rule → `unsafe_operator`; over-ceiling effect → `effect_out_of_bounds`; oversize → `condition_too_large`; over-quota rule set → `rule_set_limit_exceeded`; authored-max set only by admin, ≥ base & ≤ cap — all validated before persist (SC-001/019) |
| US2 — A rule adjusts a decision, deterministically & bounded | P1 🎯 MVP | evaluate.ts highest-priority-wins ONE effect + tiebreak + considered-not-applied + canonical-hash audit + fail-closed; the E008 issuance hook (pre-sign) | matching context applies the bounded effect (SC-002); re-evaluate → identical decision + fired rule + input_hash (SC-003); over-max clamped/refused, lift-above-base allowed (SC-004/015); issuance-only, no per-validate re-decision (SC-016); already-issued offline token verifies byte-identical (SC-014) |
| US3 — Sandboxed evaluation that cannot execute code and fails closed | P1 🎯 MVP | the sandboxed allow-listed non-eval evaluator + resource bounds + fail-closed wrapper + per-decision rule cap | an eval/host/IO/global expression is refused with no host state touched (SC-005); an error/timeout/bound/per-decision-cap breach → base decision + audited, issuance never blocked even when the audit write itself fails (SC-006/017/020) |
| US4 — Dry-run / simulate a rule | P2 | POST `/admin/policy/rules/:ruleKey/dry-run` (supplied or real context, non-enforcing, `mode=dry_run`) + supplied-context bounding | dry-run a candidate against a sample/real context → would-be decision + fired + considered-not-applied; a supplied context out-of-schema/oversized/over-depth is rejected before evaluation; no live decision/rule state changes (SC-007/018) |
| US5 — Versioned, auditable rule lifecycle | P2 | POST `.../status` (active/preview/disabled + 409 invalid_state_transition) + preview report-only + unified mode-marked append-only audit | edit → new immutable version, prior retained; preview logs would-be without enforcing (SC-008); every eval writes a mode-marked audit row with fired id+version + considered_rules + canonical hash + decision (SC-009) |
| US6 — Deterministic conflict resolution & precedence | P2 | explicit priority + stable (rule_key,version) tiebreak + author-time overlap/unreachable lint | overlapping distinct-priority rules → highest wins reproducibly; same-priority → stable tiebreak; overlapping/unreachable rule → lint warning (SC-010) |

**MVP gate**: US1 + US2 + US3 (all P1) — author/validate a guarded rule, have it deterministically adjust a bounded entitlement decision at issuance, inside a provably sandboxed fail-closed engine — form a viable low-code policy-rule core. US4 + US5 + US6 (P2) are in-scope, not deferred.

## Brownfield Notes

- **Existing flows touched**: `migrations/` (adds sequential `0013_policy_rules.sql` after `0012`; no change to `0000`–`0012`); `src/server/modules/index.ts` (registers the policy seam AFTER `registerUsage`); `src/server/config/index.ts` (adds policy config keys incl. the FR-019 cost caps, the FR-021 absolute cap, and the FR-014 retention window); `src/server/main.ts` (starts the fail-open policy_evaluation retention prune worker, unref'd, on `app.close()`); `src/server/modules/issuance/licenses.ts` (hooks `app.policy.evaluate` into the effective-definition → snapshot BEFORE the E004 signer runs — the E004 signer + E001 verifier + LIC1 token bytes UNCHANGED); `src/server/modules/catalog/{validation.ts,entitlements.ts,routes.ts}` (the authored `rule_max`/`rule_eligible`/`rule_tiers` governance action); `src/admin-ui/` (a Policy Rules page — Polish); `.github/workflows/` (adds `policy.yml`, mirroring `usage.yml`); `vitest.config.ts` (coverage glob + gate).
- **Cross-epic reuse points (dependency seams)**: E008 issuance `getEffectivePlanDefinition` (catalog/effective.ts) → the pre-sign `evaluate` hook (FR-008, HINT-002); E004 signer + E001 verifier → UNCHANGED, no crypto (FR-018, SC-014); E007 catalog `entitlement` → the authored-max / rule-eligible / tiers bound surface + governance (FR-003/007/021, AD-003); E016 usage aggregate → the `has()`-guarded decision context (FR-004); E008 license claims → read-only decision context (FR-004); E005 console session + `rbac-middleware.ts` + double-submit CSRF → the rule + catalog admin surface (FR-001/016/021); E014/E016 fail-open owner-role retention prune worker → the `policy_evaluation` retention prune (FR-014).
- **Patterns reused**: the `register<Module>` seam (registered after `registerUsage`); the E014/E016 forced-RLS composite-FK + append-only-ledger + BRIN-retention migration form; `withTenant()`/`privileged` as the sole RLS choke point; the E014/E015 fail-open synthetic-actor retention worker shape; the E016 `<Module>Error(code,status,details)` + `{code,message,details?}` error shape; the shared `audit_log`/`writeAudit`; Zod request validation.
- **Key constraints folded in**: NO arbitrary code execution (the allow-list IS the security boundary — no `eval`/`Function`/`vm`/host/globals/I-O); deterministic evaluation (injected decision timestamp only; no wall-clock/random/network operator; canonical input_hash so an identical context reproduces the identical hash — INV-12); every effect clamped to the authored per-entitlement maximum (a rule MAY lift above base but never above the authored max, and only toggles rule-eligible booleans / plan-defined tiers); highest-priority-wins ONE effect per entitlement (no chaining; others recorded considered-but-not-applied); BOUNDED per-issuance cost (per-tenant max active/preview rule-set size rejected at author time via `rule_set_limit_exceeded`; a per-decision rule cap fails closed at evaluation — FR-019); fail-closed on any error/timeout/bound/absent-field/cap (base static decision stands, issuance never crashes/blocks, failure audited, audit-write failure ALSO fails closed); immutable content versioning (edit = new version; STATUS is the only mutable column, repo-restricted UPDATE; an impermissible transition → 409 invalid_state_transition); forced-RLS tenant isolation (cross-tenant → 404, unset GUC → zero rows); minimized decision context + audit (no secret/signing key/PII); authored-max governance (admin-only + CSRF + audited, ≥ base & ≤ absolute cap — FR-021); issuance/signing-path only, offline token + verifier byte-unchanged, no new crypto.
- **Regression focus**: the E007 boolean/integer_limit/metered entitlement semantics + `plan_entitlement` value columns are UNCHANGED (`rule_max`/`rule_eligible`/`rule_tiers` are additive authored-bound attributes); the E008 issuance snapshot/sign path is post-processed BEFORE signing only (the E004 signer, E001 verifier core, and LIC1 token layout are untouched — an already-issued offline token verifies byte-identical); E002 RLS/tenant isolation + append-only audit keep working; the two new policy tables are additive + forced-RLS; the admin plane = console session + RBAC (viewer reads; admin authors/edits/status/dry-run + sets the authored max) + double-submit CSRF (there is NO runtime / API-key plane and NO wire evaluation endpoint — evaluation is an internal issuance-path seam).

---

## Phase 1: Setup (Repository / Workspace Delta)

- [ ] T001 Extend coverage globs for src/server/modules/policy/** (≥80% line+branch) in vitest.config.ts
- [ ] T002 {FR-009,FR-019,FR-021,FR-014} Policy config keys (eval timeout; size/AST-depth/complexity caps; rule-set + per-issuance cost caps FR-019; absolute authored-max cap FR-021; audit retention window FR-014; conflict policy) in src/server/config/index.ts
- [ ] T003 Module scaffold: registerPolicy seam + PolicyError + app.policy (evaluate seam) in src/server/modules/policy/index.ts → exports: registerPolicy, PolicyError
- [ ] T004 Register registerPolicy after registerUsage (end of MODULES) in src/server/modules/index.ts ← T003:registerPolicy

---

## Phase 2: Foundational (Cross-Work-Item Blockers)

**The migration `0013` (finalized across T005→T006, same file), the module scaffold + seam (Phase 1), the E007 rule-bound authoring + governance validation (T007), and the shared building blocks — `config.ts` (resource-bound + cost-cap + retention resolvers), the SANDBOXED `condition.ts` evaluator, `context.ts` (+ canonical hash), `effect.ts`, `validate.ts`, and `rule-repo.ts` (+ the live-rule-count for the FR-019 cap) — block every delivery story (authoring AND evaluation compose them). Complete before any US phase. The unit tests (T008–T012) are TDD-first and precede their implementations; the migration + repo integration tests (T019–T020) verify the finalized artifacts. The condition/effect sandbox + clamp unit tests carry the load-bearing sandbox-escape / no-eval / determinism / effect-clamp acceptance evidence ADR-0014 requires.**

- [ ] T005 {FR-007} Migration 0013: entitlement expand-only rule_max/rule_eligible/rule_tiers columns + nonneg/array CHECKs (default rule_eligible=false) in migrations/0013_policy_rules.sql
- [ ] T006 {FR-011,FR-014,FR-015} Migration 0013: policy_rule + policy_evaluation (+considered_rules, canonical input_hash, license-shape CHECK) — one-live UNIQUE, forced RLS, grants, indexes, BRIN retention in migrations/0013_policy_rules.sql after:T005
- [ ] T007 [P] {FR-007,FR-021} E007 rule-bound authoring + governance: rule_max/rule_eligible/rule_tiers validation (≥ base plan value, ≤ absolute cap) + persistence in src/server/modules/catalog/validation.ts + entitlements.ts after:T005
- [ ] T008 [P] Unit (TDD): config resolvers — eval timeout + JSON size/AST-depth/complexity caps + rule-set/per-issuance cost caps + absolute authored-max cap + retention window + conflict policy in src/server/modules/policy/__tests__/config.unit.test.ts
- [ ] T009 [P] Unit (TDD): sandboxed evaluator — no eval/vm, escape refused (no host/IO reachable), determinism, timeout/depth bounds in src/server/modules/policy/__tests__/condition.unit.test.ts
- [ ] T010 [P] Unit (TDD): effect applier — clamp adjust_limit ≤ authored max, toggle only rule-eligible, select only plan tier in src/server/modules/policy/__tests__/effect.unit.test.ts
- [ ] T011 [P] Unit (TDD): author-time validate — shape + allow-list + type-check + effect-bounds → distinct 400 codes in src/server/modules/policy/__tests__/validate.unit.test.ts
- [ ] T012 [P] Unit (TDD): context builder — allow-listed minimized fields, has()-guard, no secret/PII, canonical serialization/hash reproducible (INV-12) in src/server/modules/policy/__tests__/context.unit.test.ts
- [ ] T013 [P] {FR-009,FR-019} Config resolvers — eval timeout + size/AST-depth/complexity caps + rule-set/per-issuance cost caps + retention + conflict policy in src/server/modules/policy/config.ts → exports: PolicyConfig
- [ ] T014 {FR-005,FR-009} [COMPLETES FR-005] Sandboxed allow-listed non-eval evaluator (injected clock, bounded, deterministic) in src/server/modules/policy/condition.ts → exports: evaluateCondition after:T013
- [ ] T015 {FR-004,FR-017} [COMPLETES FR-004] Bounded minimized decision-context builder (E007/E008/E016, has()-guarded) + canonical hash (INV-12) in src/server/modules/policy/context.ts → exports: buildDecisionContext, canonicalContextHash
- [ ] T016 {FR-003,FR-007} [COMPLETES FR-003,FR-007] Closed typed effect applier: clamp ≤ rule_max, rule_eligible toggle, plan-tier select in src/server/modules/policy/effect.ts → exports: applyEffect
- [ ] T017 {FR-002} Author-time validate: allow-list + type-check + effect-bounds, reject-before-persist in src/server/modules/policy/validate.ts ← T016:applyEffect → exports: validateRule after:T014
- [ ] T018 {FR-011,FR-014,FR-019} Rule repo: CRUD + immutable versioning + UPDATE restricted to status/updated_at + eval append + live-rule-count + reads in src/server/modules/policy/rule-repo.ts → exports: PolicyRuleRepo
- [ ] T019 [P] Migration IT (TDD): unset-GUC→0 both tables + version/one-live UNIQUE + dry-run-license CHECK + considered_rules array CHECK in src/server/modules/policy/__tests__/migration.integration.test.ts after:T006
- [ ] T020 [P] Repo IT (TDD): content-column UPDATE refused, restricted to status/updated_at (INV-2) in src/server/modules/policy/__tests__/rule-repo.integration.test.ts after:T018

---

## Phase 3: US1 — Author and validate a guarded rule (Priority: P1) 🎯 MVP

**Independent test**: author a syntactically valid, safe, in-bounds `when → then` rule → it validates and saves as version 1 (SC-001); author a rule whose condition uses a disallowed/host-access construct → `400 unsafe_operator`, NOT persisted; author a rule whose effect exceeds the authored maximum or targets an undefined entitlement → `400 effect_out_of_bounds`, NOT persisted; an oversize condition → `400 condition_too_large`; an authoring action that would push the tenant's live rule set past the configured size → `400 rule_set_limit_exceeded`, NOT persisted; a viewer attempting to author → `403 forbidden`; a missing/mismatched CSRF → `403`, audited; a PATCH edit → a new immutable version with the prior retained; setting/raising an entitlement's authored maximum succeeds only for an admin over a CSRF-protected audited action and only when ≥ the base plan value and within the absolute cap (SC-019).

- [ ] T021 [P] [US1] {FR-002} IT (TDD): create/edit reject the distinct 400 codes before persist — invalid_condition/unsafe_operator/effect_out_of_bounds/condition_too_large (SC-001) in src/server/modules/policy/__tests__/authoring.integration.test.ts
- [ ] T022 [P] [US1] {FR-001,FR-016} IT (TDD): session+RBAC+CSRF on routes; viewer denied; CSRF miss→403; PATCH→new version in src/server/modules/policy/__tests__/rules-routes.integration.test.ts
- [ ] T023 [P] [US1] {FR-021} IT (TDD): catalog authored-max admin-only + CSRF + audited; refused when < base or > absolute cap; viewer/out-of-range refused (SC-019) in src/server/modules/catalog/__tests__/authored-max.integration.test.ts
- [ ] T024 [US1] {FR-001,FR-016} [COMPLETES FR-001] Routes: POST create + GET list/detail + PATCH edit→new version in src/server/modules/policy/routes.ts ← T017:validateRule, T018:PolicyRuleRepo
- [ ] T025 [US1] {FR-002} [COMPLETES FR-002] Wire validate-before-persist into create/edit; distinct 400 codes; rejected rule never persisted in src/server/modules/policy/routes.ts after:T024
- [ ] T026 [US1] {FR-019} [COMPLETES FR-019] Author-time rule-set size cap: reject rule_set_limit_exceeded (400) when the live rule set would exceed the configured max in src/server/modules/policy/validate.ts + rule-repo.ts + routes.ts after:T025 ← T018:PolicyRuleRepo
- [ ] T027 [US1] {FR-021} [COMPLETES FR-021] Catalog route: set/raise rule_max/rule_eligible/rule_tiers (admin-only + CSRF + audited) in src/server/modules/catalog/routes.ts after:T007

---

## Phase 4: US2 — A rule adjusts a decision, deterministically and within bounds (Priority: P1) 🎯 MVP

**Independent test**: define a rule "when usage > 10,000 then set api_calls to 50,000"; resolve at issuance with a matching context → the limit becomes 50,000 (SC-002); with a non-matching context → the base value stands; re-resolve the matching context → an identical decision, fired rule, AND input_hash (SC-003); an effect above the authored maximum is clamped/refused while a lift above the base plan value (up to the authored max) is allowed (SC-004/015); evaluation runs only on the issuance/signing path with no per-validate re-decision (SC-016); an already-issued offline license token verifies byte-identical — no token bytes change and no code runs in the verifier core (SC-014).

- [ ] T028 [P] [US2] {FR-006} Unit (TDD): highest-priority-wins ONE effect + stable (rule_key,version) tiebreak + considered-not-applied + fail-closed skip in src/server/modules/policy/__tests__/evaluate.unit.test.ts
- [ ] T029 [P] [US2] {FR-008} IT (TDD): adjusts at issuance; determinism (identical decision+fired+input_hash); clamp/lift; issuance-only no per-validate re-decision; offline token unchanged (SC-002/003/004/014/016) in src/server/modules/policy/__tests__/issuance.integration.test.ts
- [ ] T030 [US2] {FR-006,FR-010,FR-014} Evaluate: highest-priority-wins ONE effect + tiebreak + considered_rules + fail-closed + canonical-hash audit in src/server/modules/policy/evaluate.ts ← T015:canonicalContextHash, T016:applyEffect → exports: evaluatePolicy after:T016
- [ ] T031 [US2] {FR-008} [COMPLETES FR-008] E008 hook: adjust effective def BEFORE sign (signer/verifier/token untouched) in src/server/modules/issuance/licenses.ts after:T030 ← T030:evaluatePolicy

---

## Phase 5: US3 — Sandboxed evaluation that cannot execute arbitrary code and fails closed (Priority: P1) 🎯 MVP

**Independent test**: attempt to author/evaluate an expression that calls eval/require/process, reaches a host global, or loops unboundedly → each is refused at author time or fails closed at evaluation with no side effect and no host state read or written (SC-005); a well-formed rule evaluates within the configured resource bounds; a deliberately slow/over-limit or erroring rule, or a rule set exceeding the per-decision rule cap, times out / fails closed to the base decision, the issuance path neither crashes nor blocks, and the failure is audited — including when the audit write itself fails (SC-006/017/020).

- [ ] T032 [P] [US3] {FR-009} IT (TDD): sandbox-escape — eval/vm/host/IO refused, NO host state read/written (SC-005) in src/server/modules/policy/__tests__/sandbox-escape.integration.test.ts
- [ ] T033 [P] [US3] {FR-010,FR-019} IT (TDD): error/timeout/bound + per-decision rule cap → base + audited; audit-write failure ALSO fails closed (SC-006/017/020) in src/server/modules/policy/__tests__/fail-closed.integration.test.ts
- [ ] T034 [US3] {FR-009} [COMPLETES FR-009] Enforce sandbox resource bounds (timeout + size/AST-depth/complexity) at author + eval paths in src/server/modules/policy/condition.ts after:T030
- [ ] T035 [US3] {FR-010,FR-019} [COMPLETES FR-010] Fail-closed: per-rule error/timeout/bound + per-decision rule cap skip → base + audited; audit-write failure also fails closed in src/server/modules/policy/evaluate.ts after:T034

---

## Phase 6: US4 — Dry-run / simulate a rule before activating it (Priority: P2)

**Independent test**: author a candidate rule, dry-run it against a supplied sample context or a real license/plan context, and confirm the returned would-be decision + fired rule (id+version) + considered-but-not-applied rules match expectation while no live entitlement decision, license, or rule-enforcement state changed and nothing was persisted as active (SC-007); a supplied context that is out-of-schema, oversized, or over-depth is rejected (`validation_error`) under the SAME allow-listed schema + size/AST-depth/field-count bounds as the real assembled context BEFORE any evaluation, while a within-bounds supplied context evaluates identically to an assembled real context (SC-018); the dry-run is recorded distinctly mode-marked `dry_run` (with a nullable/synthetic license reference for a supplied context).

- [ ] T036 [P] [US4] {FR-013} IT (TDD): dry-run → decision + fired + considered-not-applied; no persist/enforce; mode=dry_run (SC-007) in src/server/modules/policy/__tests__/dry-run.integration.test.ts
- [ ] T037 [P] [US4] {FR-020} IT (TDD): supplied context out-of-schema/oversized/over-depth → validation_error before eval; within-bounds evaluates identically to real (SC-018) in src/server/modules/policy/__tests__/dry-run-context-bound.integration.test.ts
- [ ] T038 [US4] {FR-013,FR-016} [COMPLETES FR-013] POST .../dry-run (supplied|real ctx, candidate validated, non-enforcing, mode=dry_run) in src/server/modules/policy/routes.ts after:T030 ← T030:evaluatePolicy
- [ ] T039 [US4] {FR-020} [COMPLETES FR-020] Bound the dry-run SUPPLIED context vs the SAME allow-listed schema + size/AST-depth/field-count caps (reject validation_error before eval) in src/server/modules/policy/context.ts + routes.ts after:T038 ← T015:buildDecisionContext

---

## Phase 7: US5 — Versioned, auditable rule lifecycle (Priority: P2)

**Independent test**: author a rule, put it in preview and confirm it logs a would-be decision without changing the enforced outcome (SC-008); edit it and confirm a new immutable version is created while the prior version is retained (SC-008); attempt a status transition the lifecycle does not permit from the current state → `409 invalid_state_transition`, no state changes; resolve a decision and confirm the append-only audit records the fired rule id + version, the considered-but-not-applied rule ids + versions, a canonical input snapshot/hash, and the resolved decision, distinctly marking enforced vs preview vs dry-run (SC-009).

- [ ] T040 [P] [US5] {FR-011,FR-012} IT (TDD): edit→new version, prior retained; preview logs would-be, not enforced; impermissible transition→409 (SC-008) in src/server/modules/policy/__tests__/lifecycle.integration.test.ts
- [ ] T041 [P] [US5] {FR-014} IT (TDD): unified mode-marked append-only audit; fired id+version + considered_rules + canonical hash/snapshot + decision (SC-009) in src/server/modules/policy/__tests__/audit.integration.test.ts
- [ ] T042 [US5] {FR-011} [COMPLETES FR-011] POST .../status (active|preview|disabled) + single-live promotion + 409 invalid_state_transition (session+RBAC+CSRF) in src/server/modules/policy/routes.ts after:T024
- [ ] T043 [US5] {FR-012} [COMPLETES FR-012] Preview (report-only) branch in evaluate — logs would-be decision, enforced outcome unchanged in src/server/modules/policy/evaluate.ts after:T035
- [ ] T044 [US5] {FR-014} Unified mode-marked append-only policy_evaluation write: fired id+version + considered_rules + canonical input_hash/snapshot + decision in src/server/modules/policy/evaluate.ts after:T043

---

## Phase 8: US6 — Deterministic conflict resolution and precedence (Priority: P2)

**Independent test**: define two overlapping rules with different priorities targeting the same entitlement, resolve a matching context, and confirm the higher-priority rule's effect wins reproducibly on every re-evaluation (SC-010); define two same-priority overlapping rules and confirm the stable (rule_key,version) tiebreak yields one reproducible outcome; author an overlapping/unreachable rule and confirm the author-time lint flags it.

- [ ] T045 [P] [US6] {FR-006} IT (TDD): distinct-priority → highest wins; same → tiebreak; overlap/unreachable → lint (SC-010) in src/server/modules/policy/__tests__/conflict.integration.test.ts
- [ ] T046 [US6] {FR-006} [COMPLETES FR-006] Priority + stable (rule_key,version) tiebreak + author-time overlap/unreachable lint in src/server/modules/policy/evaluate.ts + validate.ts after:T030

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T047 {FR-016} [COMPLETES FR-016] Finalize RBAC + double-submit CSRF 403 on every mutation + audit each denial as a security event in src/server/modules/policy/routes.ts after:T042
- [ ] T048 {FR-014} [COMPLETES FR-014] Fail-open owner-role policy_evaluation retention prune (config window, BRIN, synthetic-actor audit) in src/server/modules/policy/retention-worker.ts + src/server/main.ts after:T044
- [ ] T049 [P] {FR-015} [COMPLETES FR-015] Isolation IT: cross-tenant→404 all routes; unset-GUC→0 rows on both tables (SC-012) in src/server/modules/policy/__tests__/isolation.integration.test.ts
- [ ] T050 [P] {FR-017} [COMPLETES FR-017] Security/PII IT: no secret/key/PII in condition/context/response/log/audit; minimized (SC-013) in src/server/modules/policy/__tests__/secret-leakage.test.ts
- [ ] T051 [P] {FR-018} [COMPLETES FR-018] NO-CRYPTO IT: no crypto/signer/verifier touch; issued token byte-identical (SC-014) in src/server/modules/policy/__tests__/no-crypto.integration.test.ts
- [ ] T052 [P] Perf IT: author-time validation fast + bounded evaluation honors timeout/size/depth caps + per-decision rule cap on issuance in src/server/modules/policy/__tests__/perf.integration.test.ts
- [ ] T053 Enforce ≥80% line+branch coverage of src/server/modules/policy/** in vitest.config.ts after:T052
- [ ] T054 [P] Add policy CI (typecheck+lint, Testcontainers IT+coverage, npm audit, semgrep + a sandbox/no-eval lint; SHA-pinned actions) in .github/workflows/policy.yml mirroring usage.yml
- [ ] T055 Policy Rules admin page (author/validate, priority, preview/active, dry-run, version history) in src/admin-ui/src/pages/policy/PolicyRules.tsx after:T038

---

## Dependencies

Setup (Phase 1) → Foundational (Phase 2) → US1 (Phase 3) → US2 (Phase 4) → US3 (Phase 5) → US4 (Phase 6) → US5 (Phase 7) → US6 (Phase 8) → Polish (Phase 9)

- **Phase 1 (Setup)** has no dependencies. T002 adds the eval-bound / cost-cap (FR-019) / absolute-cap (FR-021) / retention (FR-014) / conflict-policy config keys the `config.ts` resolver (T013) reads live. T003 (scaffold: `registerPolicy` + `PolicyError` + `app.policy` evaluate seam) + T004 (seam registration, needs T003's `registerPolicy`) wire the module after `registerUsage`.
- **Phase 2 (Foundational)** depends on Setup. The migration is finalized across T005→T006 (same file, sequential: the E007 entitlement rule-bound columns, then the two policy tables — incl. the new `considered_rules` column, the canonical `input_hash`, the license-shape CHECK, and BRIN retention — plus RLS/indexes/grants). T007 authors + governs those E007 columns (after:T005, FR-007 persistence + FR-021 ≥base/≤cap validation). The unit tests T008–T012 precede their implementations (TDD-first; T012 also proves the canonical-hash reproducibility). `config.ts` (T013), `condition.ts` (T014, the SANDBOX — completes FR-005), `context.ts` (T015, minimized + canonical hash — completes FR-004), `effect.ts` (T016, the clamp — completes FR-003/FR-007), `validate.ts` (T017), and `rule-repo.ts` (T018, incl. the live-rule-count the FR-019 cap reads) are the cross-story blockers: authoring (US1) AND evaluation (US2+) compose them. T019 verifies the migration (after:T006); T020 verifies the repo's UPDATE-restricted-to-status content-immutability guard (after:T018, auditor note a).
- **US1–US3 (P1)** each depend on the Foundational blockers and are independently testable slices. Per-story integration tests are TDD-first and precede implementation. `routes.ts` is created in US1 (T024 create/list/detail/PATCH) → T025 (validate-before-persist) → T026 (rule-set size cap) and extended by US4 (T038 dry-run), US5 (T042 status), and Polish (T047 RBAC/CSRF finalize) — these same-file edits are sequential, never `[P]` together. FR-021 is authored in the catalog: T007 (validation) → T027 (route + admin/CSRF/audit), tested by T023.
- **US2 (P1)** builds `evaluate.ts` (T030 — highest-priority-wins one effect + tiebreak + considered_rules + fail-closed + canonical-hash audit, composing the condition/context/effect blocks via ← T015/T016) and the E008 issuance hook (T031, after:T030, ← T030 `evaluatePolicy`, post-processing the effective definition BEFORE the E004 signer — verifier + token bytes untouched).
- **US3 (P1)** hardens `condition.ts` resource bounds (T034, after:T030) and the `evaluate.ts` fail-closed wrapper — per-rule error/timeout/bound + the FR-019 per-decision rule cap, incl. the audit-write-failure-also-fails-closed guard (T035, after:T034, auditor note b).
- **US4 (P2)** adds the dry-run route (T038, after:T030, ← T030 `evaluatePolicy`) — non-enforcing, mode-marked `dry_run` — then bounds the supplied context against the same allow-listed schema + size/depth/field-count caps (T039, after:T038, ← T015 `buildDecisionContext`, completes FR-020).
- **US5 (P2)** adds the status route with the 409 invalid_state_transition guard (T042, after:T024), the preview report-only evaluate branch (T043, after:T035), and the unified mode-marked append-only audit write with considered_rules + canonical hash (T044, after:T043).
- **US6 (P2)** extends `evaluate.ts` + `validate.ts` (T046, after:T030) with the explicit priority/tiebreak + author-time overlap/unreachable lint — completing FR-006.
- **Polish (Phase 9)** depends on the delivery routes/handlers: RBAC/CSRF finalize (T047, after:T042), the fail-open retention prune worker (T048, after:T044), the isolation / secret-PII / no-crypto / perf integration suites (T049–T052, distinct files, `[P]`), the coverage gate (T053, after:T052), CI (T054), and the admin-ui Policy Rules page (T055, after:T038).
- **Shared same-file chains** (all sequential, never `[P]` together): `migrations/0013_policy_rules.sql` (T005→T006); `condition.ts` (T014→T034); `context.ts` (T015→T039); `evaluate.ts` (T030→T035→T043→T044→T046); `routes.ts` (T024→T025→T026→T038→T039→T042→T047); `validate.ts` (T017→T026→T046); `rule-repo.ts` (T018→T026); `catalog` (T007→T027); `config/index.ts` (T002); `config.ts` (T013); `main.ts` (T048); `vitest.config.ts` (T001→T053).
- Tasks marked `[P]` are parallelizable within their phase (distinct files, no intra-batch dependency). A task with `after:T###` or `← T###:Symbol` is never `[P]`-batched with the task it references. All same-file edits are sequential.

## Delivery Notes

- **Sandbox as the security boundary (AD-001/HINT-001, INV-6)**: `condition.ts` (T014) is an in-house allow-listed JSONLogic-subset evaluator — NEVER `eval`/`Function`/`vm`. The operator allow-list (comparison, boolean logic, allow-listed `var` field access, `has()` guard, bounded arithmetic — NO time/random/network/custom op) IS the boundary; the injected `decisionTimestamp` is the only time source. Author validation enforces the JSON size / AST-depth / complexity caps; each evaluation is timeout-bounded (T034). The sandbox-escape IT (T032) proves no host state is reachable, and the determinism unit + issuance IT (T009/T029) prove idempotent re-evaluation with an identical `input_hash` (SC-003/005).
- **Canonical determinism (INV-12)**: `context.ts` (T015) computes `input_hash` (and any `input_snapshot`) over a CANONICAL serialization — stable key ordering, normalized value encoding — so an identical decision context reproduces the identical hash; `evaluate.ts` (T030/T044) records it, and the issuance IT (T029) asserts an identical decision + fired rule + `input_hash` on re-evaluation (FR-005, SC-003).
- **Closed typed effect + authored-max clamp + governance (AD-002/003/HINT-003, INV-4)**: a rule returns a descriptor `{kind,target,value}`; `effect.ts` (T016) is the single trusted applier that clamps `adjust_limit` to `entitlement.rule_max` (≥ the base plan value — a service-layer check, since a single-table CHECK cannot join `plan_entitlement.int_value`), toggles a boolean ONLY where `rule_eligible`, and selects ONLY a `rule_tiers` value. An over-bound effect is refused at author time (T017/T025 → `effect_out_of_bounds`) AND clamped/skipped at evaluation (T030). Setting/raising the ceiling is itself an admin-only, CSRF-protected, audited catalog action validated ≥ base and ≤ the configured absolute cap (T007 validation + T027 route, FR-021, SC-019). A rule MAY lift above base but never above the authored max (SC-004/015).
- **Per-issuance cost bound (FR-019, INV-7)**: config (T002/T013) sources a per-tenant MAX active/preview rule-set size and a MAX rules evaluated per issuance. An authoring action that would push the tenant's live rule set past the size cap is REJECTED at author time (T026 → `400 rule_set_limit_exceeded`, [COMPLETES FR-019]); an evaluation that would exceed the per-decision rule cap FAILS CLOSED (T035 — the base static decision stands, the breach is audited), so the signing path stays bounded regardless of rule-set growth (SC-017). (Per the task brief the FR-019 completion marker sits on the author-time cap task T026; the evaluation-side cap is carried by the fail-closed task T035.)
- **Issuance-only, no crypto (AD-004/HINT-002, INV-11)**: the `evaluate` seam post-processes the effective entitlement definition (`getEffectivePlanDefinition`) in `issuance/licenses.ts` (T031) BEFORE the E008 snapshot is signed by the existing E004 signer; it runs no code in the E001 verifier core, changes no LIC1 token bytes, and performs NO cryptography (SC-014). Evaluation runs only at issuance — no per-validate re-decision (SC-016). A separate online E013 validate-time surface is DEFERRED beyond this epic.
- **Highest-priority-wins (AD-005, INV-5)**: exactly ONE matching rule's effect applies per entitlement (no chaining); the `(tenant_id, entitlement_id, status, priority DESC)` index drives the deterministic scan with a stable `(rule_key, version)` tiebreak; others are recorded in the `considered_rules` column of the audit (T030/T044/T046, SC-010).
- **Immutable versioning + status lifecycle (AD-006/HINT-004, INV-2/INV-3)**: a content edit INSERTs a new `(rule_key, version+1)` row; `status` is the ONLY mutable column — the repo restricts UPDATE to `status`/`updated_at` (T018), proven by the content-immutability IT (T020, auditor note a). `policy_rule_one_live` guarantees at most one live (active|preview) version per rule_key; a status transition the lifecycle does not permit from the current state → `409 invalid_state_transition` (T042). A preview version logs its would-be decision report-only (T043); a disabled version never evaluates.
- **Fail-closed, audited (HINT-005, INV-7)**: `evaluate.ts` wraps each rule so an error / timeout / bound breach / unguarded absent-field / per-decision-cap breach skips that rule (the base static decision for that entitlement stands, `fired_rule=NULL`) and still appends an audited failure — a bad rule NEVER crashes or blocks the issuance path. A `policy_evaluation` audit-write failure during issuance ALSO fails closed: the base decision stands, the token is still issued, and the persistence failure is surfaced to operational logging never the signing path (T035, auditor note b, SC-006/020).
- **Unified mode-marked audit + retention (AD-008, INV-8)**: `policy_evaluation` is append-only (grant SELECT,INSERT); every enforced / preview / dry-run evaluation writes exactly one mode-marked row (fired rule id+version or null, `considered_rules` array, canonical input hash/snapshot, resolved decision); a supplied-context dry-run carries a nullable/synthetic license ref (T044, SC-009). A fail-open owner-role prune over a config-sourced retention window (BRIN on `created_at`, mirroring `usage_event`/`billing_event`) bounds the trail (T048, [COMPLETES FR-014]).
- **Dry-run supplied-context bounding (FR-020, INV-9)**: a `dry_run` persists an audit row but changes no live decision/license/rule state; a SUPPLIED context is validated against the SAME allow-listed schema + serialized-size / AST-depth / field-count caps as the real assembled context BEFORE evaluation (T039 → `validation_error`), so an admin cannot inject an oversized/out-of-schema context to escape the resource bounds or bypass FR-002/FR-009 (SC-018).
- **Tenant isolation + minimization (INV-1/INV-10)**: forced RLS on both tables (unset GUC → zero rows, cross-tenant → 404, T049); the decision context + every audit projection are minimized to allow-listed pseudonymous fields — no secret, signing key, or PII (T050, SC-012/013).
- **Tests**: integration suites use `@testcontainers/postgresql` reusing the billing/usage RLS + admin-session harness; evaluation is driven deterministically via the injected decision timestamp; the unit tier drives the config resolvers, the sandboxed evaluator (no-eval/escape/determinism/bounds), the effect clamp, the author-time validate, and the context minimization + canonical hash.
- No deferred work within the epic: US4/US5/US6 (P2) are fully in-scope; the MVP gate is US1 + US2 + US3. The online E013 validate-time evaluation surface is the only disclosed out-of-epic deferral (FR-008).

## Requirement Coverage

| Req | Tasks | Completing task |
|-----|-------|-----------------|
| FR-001 | T018, T022, T024 | T024 |
| FR-002 | T011, T017, T021, T025 | T025 |
| FR-003 | T010, T016 | T016 |
| FR-004 | T012, T015 | T015 |
| FR-005 | T009, T014 | T014 |
| FR-006 | T028, T030, T045, T046 | T046 |
| FR-007 | T005, T007, T010, T016 | T016 |
| FR-008 | T029, T030, T031 | T031 |
| FR-009 | T002, T008, T009, T013, T014, T032, T034 | T034 |
| FR-010 | T030, T033, T035 | T035 |
| FR-011 | T006, T018, T040, T042 | T042 |
| FR-012 | T040, T043 | T043 |
| FR-013 | T036, T038 | T038 |
| FR-014 | T002, T006, T018, T041, T044, T048 | T048 |
| FR-015 | T006, T019, T049 | T049 |
| FR-016 | T022, T024, T038, T042, T047 | T047 |
| FR-017 | T012, T015, T050 | T050 |
| FR-018 | T031, T051 | T051 |
| FR-019 | T002, T013, T026, T033, T035 | T026 |
| FR-020 | T037, T039 | T039 |
| FR-021 | T002, T007, T023, T027 | T027 |

**Rollup**: 21/21 functional requirements covered (FR-001..FR-021), each with exactly one `[COMPLETES FR-###]` marker. 20 success criteria exercised — SC-001 (US1), SC-002/003/004/014/015/016 (US2), SC-005/006/017/020 (US3), SC-007/018 (US4), SC-008/009 (US5), SC-010 (US6), SC-011/012/013/019 (US1 routes + catalog + Polish). 2 new tables (`policy_rule`/`policy_evaluation` — the latter with the new `considered_rules` column, canonical `input_hash`, and BRIN retention) + an expand-only `entitlement` rule-bound extension via one migration `0013_policy_rules.sql`; 6 admin endpoints (create/list/detail/edit/status incl. 409 invalid_state_transition/dry-run) + the catalog authored-max governance action + 1 internal issuance-path evaluation seam (no wire op) + 1 fail-open retention prune worker; 1 console page. P1 (US1–US3) forms a viable MVP. No deferred in-epic work; no coverage gaps. NOTE: per the task brief the FR-019 completion marker is placed on the author-time rule-set-cap task (T026); its evaluation-side per-decision cap is implemented by the fail-closed task T035.
