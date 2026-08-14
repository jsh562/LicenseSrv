---
adr_id: ADR-0015
status: accepted
date: 2026-08-14
tags: [reseller, white-label, multi-tenancy, tenant-hierarchy, delegated-administration, scoped-descent, subtree-membership-gate, forced-rls, privileged-seam, downward-only, no-existence-disclosure, dual-identity-audit, presentation-only-branding, domain-verification, suspend-offboard, operator-only-transfer, no-new-isolation-mechanism, principle-i-preserved, principle-ii-preserved]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00019-reseller-and-white-label-tenancy/spec.md, specs/00019-reseller-and-white-label-tenancy/plan.md, specs/00019-reseller-and-white-label-tenancy/research.md, migrations/0014_reseller_branding.sql, src/server/modules/reseller/]
---

# ADR-0015: Reseller Hierarchy and Delegated Cross-Tenant Administration Model

## Status

Accepted.

## Context

The platform's tenancy substrate (E002) is a FLAT set of mutually isolated tenants: every tenant-owned table carries a `tenant_id`, a forced row-level-security (RLS) predicate under a non-owner Postgres role restricts every row to the tenant named in the `app.current_tenant` GUC, cross-tenant reads resolve to not-found, and an unset GUC yields zero rows. Console access reuses the E005 session + RBAC (`owner > admin > viewer`) + double-submit CSRF, and every privileged action lands on the append-only `audit_log`. This isolation is the platform's hardest non-negotiable — project-instructions.md Principle II — and it is provable precisely because it is flat: each tenant reasons about exactly one predicate, with no cross-tenant reach anywhere in the data-access layer.

Epic E018 (Reseller and white-label tenancy, `{PRD:CAP-012}`) opens a partner/channel go-to-market: a vendor/platform operator onboards **resellers** who provision and manage their own **sub-tenants** (customers) under delegated administration, and resellers/customers **white-label** the presentation per tenant. This is the first time the platform must let one tenant's administrator reach ACROSS a tenant boundary to act on another tenant — the exact motion the flat isolation model is built to forbid. The tension is structural: enabling cross-tenant reseller reach while keeping tenant isolation provable. A naive answer — a new global role whose RLS predicate is broadened to include a parent link — would put a cross-tenant term inside the one predicate every table depends on, enlarging the isolation-reasoning surface for the whole platform and risking sibling leakage (a reseller seeing, or a bug exposing, another reseller's customers). Because the change touches the shared isolation substrate rather than one endpoint, the SHAPE of the hierarchy, the authorization motion, the read path, the audit attribution, and the branding boundary are project-level invariants, not feature-local implementation details.

The decision must also stay consistent with what is already committed and NOT re-decide it:

- **E002/ADR-0004 own tenant isolation.** The per-tenant forced-RLS predicate, the non-owner role, the `app.current_tenant` GUC, cross-tenant → not-found, and unset-GUC → zero-rows are the frozen isolation contract. A reseller layer must reuse this substrate WITHOUT introducing a new isolation mechanism or weakening the predicate.
- **E005/E006 own the console and platform administration.** The session, RBAC hierarchy, CSRF, the `privileged` (platform-admin) data-access seam, and `audit_log` are reused as-is; the reseller-admin is an existing role on a tenant, not a new auth core.
- **E004/E001 own crypto, the license, and offline verification (Principle I).** White-labeling is presentation only; it must never alter license contents, the signed `LIC1` token, or the verifier.

What this ADR decides: the **reseller-hierarchy and delegated cross-tenant administration model** — the link shape, the authorization motion, the subtree-read path, the reference-resolution rule, the audit attribution, the white-label boundary, and the lifecycle governance — as one project-level contract that E018 implements and any future multi-level or partner-administration work reuses. It relates to ADR-0014 (policy engine) only as another module layered on the same E002 substrate; it supersedes nothing.

## Decision Drivers

- **Strict tenant isolation stays provable (Principle II, non-negotiable)**: the per-tenant forced-RLS predicate must be UNCHANGED, and cross-tenant reach must live at exactly one auditable choke point rather than being smeared into the predicate every table depends on — the smallest possible isolation-reasoning surface.
- **Downward-only, no upward/lateral/IDOR escalation**: a reseller-admin may reach only its OWN sub-tenants; sibling, parent, and platform references must be structurally unreachable, and an out-of-subtree reference must not even disclose existence.
- **Reuse the single security/data foundation (Principles II/III)**: reseller authority must reuse the E005 session + RBAC + CSRF, the E002 forced-RLS + `privileged` seam, and the append-only `audit_log` — no new isolation mechanism, no new auth core, no new crypto.
- **Offline verification and the license are untouched (Principle I)**: white-labeling is presentation-only and must never change license contents, the signed token, or the verifier; an already-issued token verifies byte-identically.
- **Every cross-tenant action is attributable**: a reseller acting on a sub-tenant must leave a dual-identity append-only audit row naming both the acting reseller-admin and the target sub-tenant, so delegated authority is never anonymous.
- **Trust signals are never white-labeled**: revocation/tamper/security notices, signing identity, audit, and legal text must remain platform-truthful regardless of branding, and a custom domain/email must prove DNS ownership before activation.
- **Reversible, orphan-free governance**: suspend must be reversible and derived at request time (not a destructive cascade), offboard must transfer-or-reassign every sub-tenant with no orphans, and sub-tenant transfer must be operator-only.
- **Shallow, expand-only scope**: exactly ONE reseller level over the existing substrate, added via expand-only schema, keeps the model small and the isolation argument tractable for the MVP.

## Considered Options

### Option A: New global `reseller_admin` role with a broadened RLS predicate

Introduce a new platform-wide `reseller_admin` role and widen the per-tenant forced-RLS predicate so that a reseller-admin's rows include every tenant whose `parent_reseller_id` equals the caller's reseller.

- **Pros**: Cross-tenant subtree access becomes "free" — the same RLS predicate that scopes a tenant now also admits its managed sub-tenants, so no explicit descent gate or privileged read path is needed; a single query returns "my sub-tenants."
- **Cons**: Puts a CROSS-TENANT term inside the one predicate every tenant-owned table depends on, enlarging the isolation-reasoning surface for the ENTIRE platform — every table's isolation now depends on the correctness of the parent-link join, and a single bug (or a mis-set GUC combined with the broader predicate) risks sibling leakage (one reseller seeing another reseller's customers). It also blurs the clean "one tenant = one predicate" invariant that makes ADR-0004 provable, and a new global role is a new auth-core surface. Rejected — it trades the platform's hardest guarantee for read convenience.

### Option B: Gated scoped-descent + a controlled audited privileged read seam (composite model)

Layer a shallow one-level hierarchy on the existing substrate with the per-tenant RLS predicate UNCHANGED, and route cross-tenant reseller authority through two explicit, audited choke points:

1. **Expand-only link.** A self-referential `tenant.parent_reseller_id` (a sub-tenant points to its managing reseller tenant) plus a 1:1 `reseller` table (status `active | suspended | offboarding`, a hard `sub_tenant_quota`). The hierarchy is exactly ONE level and expand-only.
2. **Authorization = gated scoped-descent.** A reseller-admin is simply an `admin`/`owner` of a reseller tenant (reusing E005 RBAC). To act on a sub-tenant, the request first passes a subtree-membership GATE — assert the target sub-tenant's `parent_reseller_id` equals the caller's reseller — and only then executes the operation under the SUB-TENANT'S OWN `app.current_tenant` scope. The per-tenant forced-RLS predicate never changes; the reseller never "sees across" — it descends, with permission, into one child's own scope.
3. **Subtree READ = controlled platform-admin seam.** Listing "my sub-tenants" runs on the existing audited `privileged` path filtered by `parent_reseller_id = :reseller` AFTER an ownership assertion — never by broadening the RLS predicate. The seam is already trusted and audited; the filter is applied in application code at one place.
4. **Downward-only reference resolution.** Any out-of-subtree reference (sibling / parent / platform) resolves to 404 with NO existence disclosure plus a security-event audit; upward/lateral/IDOR escalation is structurally blocked.
5. **Dual-identity audit.** Every reseller action on a sub-tenant writes an append-only `audit_log` row attributing BOTH the acting reseller-admin and the target sub-tenant.
6. **Presentation-only white-label.** Per-field branding precedence (sub-tenant → reseller → platform) with reseller-lockable fields, resolved server-side per request; it NEVER alters license contents, the signed token, or the verifier (Principle I). Trust signals (revocation/tamper/security notices, signing identity, audit, legal text) are never white-labeled; custom domain/email requires DNS ownership proof before activation.
7. **Reversible governance.** Suspend is reversible and derived at request time (a read-only cascade computed from reseller status, not a destructive write); offboard transfers-or-reassigns every sub-tenant (no orphans, grace window); sub-tenant transfer is operator-only.

- **Pros**: The per-tenant forced-RLS predicate is UNCHANGED, so the isolation-reasoning surface stays minimal (one predicate per tenant, exactly as ADR-0004 fixes it); cross-tenant reach exists at exactly TWO explicit, audited choke points (the descent gate for writes/reads-in-child-scope, the filtered `privileged` seam for subtree listing) rather than being smeared into every table's predicate; downward-only + no-existence-disclosure structurally blocks upward/lateral/IDOR escalation and prevents sibling leakage; it reuses the E005 session/RBAC/CSRF, the E002 forced-RLS + `privileged` seam, and the append-only `audit_log` with no new isolation mechanism, no new auth core, and no new crypto; dual-identity audit keeps delegated authority attributable; branding is provably presentation-only so Principle I holds byte-for-byte; governance is reversible and orphan-free. The gate and the seam are small, testable, and localized.
- **Cons**: Subtree reads are NOT free — they are an explicit privileged code path (a filtered `privileged` seam) rather than a single RLS query, so the ownership-assertion filter must be correct and tested; the subtree-membership gate must be applied on EVERY reseller → sub-tenant action (a discipline enforced at the module seam, not by the database predicate), so a missed gate is a code defect the tests must catch. Deliberate trades: an explicit, auditable choke point in exchange for never touching the platform-wide isolation predicate.

### Option C: Fully separate per-reseller databases or schemas

Give each reseller its own physical database (or Postgres schema) containing its sub-tenants, isolating resellers at the storage-container level rather than by RLS.

- **Pros**: Reseller-to-reseller isolation is enforced by separate storage containers; a reseller's subtree is trivially "everything in its database/schema."
- **Cons**: Heavyweight and it BREAKS the shared substrate — provisioning, migration, connection routing, cross-cutting platform queries, and operations would all fork per reseller, and the single forced-RLS + `privileged` + `audit_log` foundation (ADR-0004/0005) would no longer be uniform. It is far more machinery than a shallow one-level delegated-admin model needs, and it does not reuse the proven per-tenant isolation the platform already ships. Rejected — disproportionate and substrate-breaking.

## Decision Outcome

Chosen option: **Option B — the gated scoped-descent + controlled audited privileged read seam model** — because it is the only option that adds a reseller → sub-tenant hierarchy WITHOUT touching the per-tenant forced-RLS predicate, keeping tenant isolation provable at the smallest possible reasoning surface while confining every cross-tenant motion to explicit, audited choke points. Concretely, the model is fixed as:

1. **Expand-only one-level link.** A self-referential `tenant.parent_reseller_id` (sub-tenant → managing reseller tenant) plus a 1:1 `reseller` table (`status active | suspended | offboarding`, hard `sub_tenant_quota`). Exactly ONE level; expand-only schema; no new isolation mechanism.
2. **Authorization = gated scoped-descent (NOT a new global role and NOT a broadened predicate).** A reseller-admin is an `admin`/`owner` of a reseller tenant (reused E005 RBAC). Acting on a sub-tenant requires a subtree-membership gate (assert the target's `parent_reseller_id` = the caller's reseller), after which the operation runs under the sub-tenant's OWN `app.current_tenant` scope. The per-tenant forced-RLS predicate is UNCHANGED.
3. **Subtree READ = controlled platform-admin seam.** "My sub-tenants" listing runs on the existing audited `privileged` path filtered by `parent_reseller_id = :reseller` after ownership assertion — never by broadening RLS (which would risk sibling leakage).
4. **Downward-only.** Out-of-subtree references (sibling / parent / platform) resolve to 404 with no existence disclosure + a security-event audit; upward/lateral/IDOR escalation is structurally blocked.
5. **Dual-identity audit.** Every reseller action on a sub-tenant writes an append-only `audit_log` row attributing BOTH the acting reseller-admin and the target sub-tenant.
6. **White-label is presentation-only.** Per-field precedence (sub-tenant → reseller → platform) with reseller-lockable fields; it NEVER alters license contents, the signed token, or the verifier (Principle I preserved). Trust signals (revocation/tamper/security notices, signing identity, audit, legal text) are never white-labeled; custom domain/email require DNS ownership proof before activation.
7. **Governance.** Reversible suspend (read-only cascade derived at request time) distinct from offboard (transfer-or-reassign every sub-tenant, no orphans, grace window); operator-only sub-tenant transfer.

This ADR fixes the reseller-hierarchy and delegated cross-tenant administration MODEL. It does NOT re-decide the E002/ADR-0004 per-tenant isolation contract (forced RLS, non-owner role, `app.current_tenant`, cross-tenant → not-found — all reused UNCHANGED), the E005 console session/RBAC/CSRF core (reused, `reseller-admin` = existing role on a reseller tenant), the E006 `privileged` seam and `audit_log` (reused, the latter with a dual-identity target-tenant projection), or the E004/E001 signing/verification/token surface (untouched; branding is presentation-only).

## Consequences

### Positive

- Partner/channel go-to-market is enabled (CAP-012): resellers provision and manage their own sub-tenants under delegated, downward-only administration, and per-tenant white-labeling ships — WITHOUT weakening tenant isolation.
- Principle II is preserved with the smallest isolation-reasoning surface: the per-tenant forced-RLS predicate is UNCHANGED, so every tenant still reasons about exactly one predicate, and cross-tenant reach lives at exactly two explicit, audited choke points (the scoped-descent gate and the filtered `privileged` subtree-read seam) rather than being smeared into the platform-wide predicate.
- Escalation is structurally blocked: downward-only reference resolution with 404-no-existence-disclosure and a security-event audit makes sibling, parent, and platform references unreachable, preventing upward/lateral/IDOR escalation and sibling leakage.
- The single security/data foundation is reused (Principles II/III): the E005 session + RBAC + CSRF, the E002 forced-RLS + `privileged` seam, and the append-only `audit_log` are reused with no new isolation mechanism, no new auth core, and no new crypto.
- Principle I holds byte-for-byte: white-labeling is presentation-only and never alters license contents, the signed token, or the verifier — an already-issued offline token verifies byte-identically — and trust signals stay platform-truthful regardless of branding.
- Delegated authority is always attributable: the dual-identity append-only audit row names both the acting reseller-admin and the target sub-tenant for every cross-tenant action.
- Governance is reversible and orphan-free: suspend is a request-time-derived read-only cascade (reversible, non-destructive), offboard transfers-or-reassigns every sub-tenant with a grace window, and sub-tenant transfer is operator-only.

### Negative

- Subtree reads are an explicit PRIVILEGED path, not a free RLS query: "my sub-tenants" listing runs on the filtered `privileged` seam, so the ownership-assertion filter is load-bearing and must be correct and tested (a defect here is the sibling-leakage risk this model exists to avoid).
- The subtree-membership gate must be applied on EVERY reseller → sub-tenant action: the discipline lives at the module seam rather than in the database predicate, so a missed gate is a code defect that the test suite (upward/lateral/IDOR-negative and no-existence-disclosure tests) must catch as load-bearing acceptance evidence.
- A custom domain/email cannot activate until DNS ownership is proven, adding a verification step (and an external-DNS dependency) before white-label domains/email go live.

### Neutral

- The hard `sub_tenant_quota` value, the offboard grace-window duration, the exact set of reseller-lockable branding fields, and the branding per-field precedence configuration are operator/config choices WITHIN this model, not separate architectural decisions.
- The model is deliberately ONE level (reseller → sub-tenant); deeper multi-level chains and reseller-of-resellers are out of scope for the MVP and a documented later enhancement, not a permanent exclusion — the gate/seam contract this ADR fixes is what any such extension would reuse.
- The DNS-based domain/email verification surface is an external-service dependency (P2) instantiated by the feature; this ADR governs the isolation and delegation model, not the verification transport.
- Enforcement of a sub-tenant's own entitlements/licenses is unchanged and remains the responsibility of the existing issuance/validate paths; the reseller layer governs administration and presentation, not license semantics.

## Links

- specs/00019-reseller-and-white-label-tenancy/spec.md — E018 (`{PRD:CAP-012}`); the delegated-administration, downward-only isolation, dual-identity audit, presentation-only branding, domain/email verification, and suspend/offboard/transfer requirements this ADR fixes the model for.
- specs/00019-reseller-and-white-label-tenancy/plan.md — the feature-local tradeoffs and the `{SAD:ADR-0015}` traceability that instantiate this project-level model (gated scoped-descent, controlled `privileged` subtree seam, additive `reseller` module).
- specs/00019-reseller-and-white-label-tenancy/research.md — the isolation-option analysis (broadened predicate vs. scoped-descent vs. separate databases) underpinning this decision.
- migrations/0014_reseller_branding.sql — the expand-only migration (self-ref `tenant.parent_reseller_id`; new `reseller`, `branding_profile`, `domain_binding` tenant-owned tables) that lands sequentially after `0013_policy_rules.sql`, preserving forced RLS.
- src/server/modules/reseller/ — the new module hosting the subtree-membership gate, scoped-descent, filtered `privileged` subtree seam, branding resolver, and dual-identity audit projection.
- ADR-0004 (Multi-Tenancy Isolation Model) — the per-tenant forced-RLS predicate, non-owner role, `app.current_tenant` GUC, cross-tenant → not-found, and `privileged` seam this decision reuses UNCHANGED and never broadens.
- ADR-0005 (Architecture Style — Modular Monolith) — the module seams the new `reseller` module and its gate/seam slot into.
- ADR-0008 (Admin Console Human Authentication — Server-Side Cookie Sessions) — the console session + RBAC (`owner > admin > viewer`) + double-submit CSRF the reseller-admin surface reuses; a reseller-admin is an existing role on a reseller tenant, not a new auth core.
- ADR-0014 (Low-Code Policy-Rule Engine) — a sibling module on the same E002 substrate; related only as another layer over the shared tenancy foundation, not superseded or otherwise coupled.
- PRD CAP-012 (reseller / white-label tenancy); project-instructions.md Principle I (offline-first / signing key never exposed / single crypto core / no token change), Principle II (multi-tenant isolation + RBAC + audit + CSRF), and Principle III (single security core, fully audited).
