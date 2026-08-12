---
adr_id: ADR-0014
status: accepted
date: 2026-08-11
tags: [low-code-policy, policy-rules, sandboxed-evaluation, jsonlogic-subset, allow-list, deterministic, injected-clock, fail-closed, bounded-effect, authored-maximum, contract-override, issuance-time-evaluation, immutable-versioning, preview-report-only, dry-run, unified-audit, highest-priority-wins, no-new-crypto, multi-tenancy]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00018-low-code-policy-rules/spec.md, specs/00018-low-code-policy-rules/plan.md, migrations/0012_usage_metering.sql, src/server/modules/catalog/effective.ts, src/server/modules/signing/signer.ts]
---

# ADR-0014: Low-Code Policy-Rule Engine — Sandboxed Deterministic JSONLogic-Subset Evaluation with Bounded Issuance-Time Effects

## Status

Accepted.

## Context

Entitlements today are STATIC. The catalog (E007) attaches a fixed value to an entitlement — a boolean flag, an integer limit, or a metered aggregation type/unit (ADR-0013) — and issuance (E008) snapshots that value verbatim into the signed license (E001 `LIC1` token). The system can say *whether* a capability is on, *how many* are allowed, and *accrue* consumption, but it cannot express a **conditional** entitlement decision: an overage tier that unlocks at a usage threshold, a contract override that lifts a limit for one customer, or a feature toggled only for a plan tier. Encoding each of these as a bespoke plan or a code change is slow and error-prone, and vendors have asked to configure such logic themselves.

Epic E017 (Low-code policy rules, `{PRD:CAP-011}`) adds a **low-code policy-rule layer**: a Licensing Admin authors guarded `when → then` rules — no free-form code — that dynamically adjust an entitlement decision within safe bounds. This is the first time the system evaluates admin-authored logic on the decision path, and the shape of that model is system-shaping rather than feature-local, because a licensing server has two hard constraints that any dynamic-decision layer must satisfy:

- **A licensing server cannot admit arbitrary code execution.** An expression evaluator built on `eval`/`Function`/`vm` would put an attacker-influenceable code path inside the control plane. How rules are expressed, validated, sandboxed, and bounded is a project-wide security invariant, not an implementation detail of one endpoint.
- **Offline verification must never change (Principle I).** The offline verifier core and the `LIC1` token byte layout are a frozen, project-wide contract consumed by every binding. A dynamic-decision layer that ran in the verifier core, or altered the token, or introduced a second crypto path, would break the offline-first guarantee. The engine must therefore adjust the entitlement decision BEFORE signing and touch nothing downstream of the signer.

The decision must also stay consistent with what is already committed elsewhere and NOT re-decide it:

- **E007 owns the entitlement model.** A rule never redefines an entitlement; it adjusts the *resolved value* of a boolean/integer_limit/metered entitlement within a vendor-authored bound. The only additive E007 change is a per-entitlement authored maximum, boolean rule-eligibility, and plan-defined tiers — expand-only, existing semantics unchanged.
- **E008 owns issuance and the license.** Rules evaluate on the issuance/signing path (initial issue and re-issuance/renewal); the license and its lifecycle are otherwise unchanged. Usage aggregates (ADR-0013) and license claims are READ-ONLY decision context.
- **E004/E001 own crypto and verification.** The engine performs NO cryptography; issuance continues to sign the (possibly rule-adjusted) snapshot with the existing E004 signer, and the E001 verifier core is untouched.
- **E005 owns scope/RBAC.** The rule admin surface reuses the console session + RBAC (admin authors/edits, viewer reads) + double-submit CSRF; no new auth core.

What this ADR decides: the **sandboxed, deterministic, low-code policy-rule engine with bounded issuance-time effects** — how a rule is expressed, validated, sandboxed, bounded, evaluated, resolved, versioned, and audited — as one project-level contract that E017 implements and future dynamic-decision work reuses. It complements ADR-0013 (metering) as the DYNAMIC-DECISION layer over the STATIC entitlement values, consuming the metering aggregate as read-only context.

## Decision Drivers

- **No arbitrary code execution (hard security boundary, non-negotiable)**: rule evaluation must be provably unable to execute arbitrary code, perform I/O, reach host globals, or exceed resource bounds — a policy engine on the control plane cannot be a `eval`/`vm` escape hatch. The operator allow-list is the security boundary.
- **Offline verification unchanged (Principle I)**: the engine must not run in the offline verifier core, must not change the `LIC1` token format, and must introduce no new cryptography — an already-issued offline token verifies byte-identically; the engine only adjusts the effective definition BEFORE the existing E004 signer runs.
- **Deterministic, reproducible decisions (correctness-critical)**: the same context must always yield the same decision — no wall-clock, randomness, network, or lookup outside the supplied context (time comes only from an injected decision timestamp), so re-evaluation at re-issuance is idempotent and every decision is explainable.
- **Provably bounded effects — a rule can never grant more than the contract allows**: every applied effect is clamped to a vendor-authored per-entitlement MAXIMUM, a boolean is toggleable only where the plan marks it rule-eligible, and a tier is selectable only among plan-defined tiers — an over-bound effect is refused at author time and clamped/skipped at evaluation.
- **Fail-closed on any failure**: an evaluation error, timeout, resource-bound breach, or unguarded absent-field access must leave the base STATIC decision standing unchanged and never crash or block the issuance path.
- **Contract-override expressibility without unbounded risk**: a rule MAY lift a limit ABOVE the base plan value (the contract-override use case) — but only up to a separately-authored maximum, so "lift above base" and "provably bounded" coexist.
- **Additive to E007 — do not mutate existing entitlement semantics**: the authored maximum, boolean rule-eligibility, and tiers are expand-only catalog attributes; boolean/integer_limit/metered semantics and the authoring flow are unchanged.
- **Reuse the single security/data foundation (Principles II/III)**: the admin surface reuses the E005 console session + RBAC + CSRF; the rule and evaluation tables reuse tenant-scoped forced RLS and the append-only audit pattern; no new crypto, no new auth core.
- **Operability and trust**: rules are immutably versioned (edit = new version), support a preview (report-only) state and dry-run/simulate for safe rollout, and every evaluation is recorded on one unified mode-marked append-only trail so any outcome is reproducible and explainable.

## Considered Options

### Option A: Sandboxed, deterministic, low-code policy-rule engine with bounded issuance-time effects (composite model)

Adopt one policy-rule model with six parts:

1. **Guarded STRUCTURED-JSON conditions evaluated by an in-house allow-listed evaluator.** A rule's condition is a structured JSON (JSONLogic-subset) expression assembled via a structured surface — NOT a free-text editor — evaluated by an in-house evaluator with a fixed pure operator allow-list (comparison, boolean logic, allow-listed field access, bounded arithmetic; NO time/random/custom/host operators). There is NO `eval`/`Function`/`vm`. The operator allow-list IS the security boundary. Every rule is validated at author time BEFORE persisting — shape + operator allow-list + context type-check against an explicit allow-listed field schema + effect-bounds — and an unparseable, unsafe, or out-of-bounds rule is rejected with a distinct reason and never persisted or evaluated.
2. **A closed, typed effect DESCRIPTOR applied by a trusted applier, always clamped to a separately-authored per-entitlement MAXIMUM.** A rule returns an effect descriptor `{kind: adjust_limit | toggle_boolean | select_tier, target, value}` — it never mutates state. A trusted server-side applier applies it to the decision and always clamps `adjust_limit` to a vendor-authored per-entitlement maximum (≥ the base plan value), toggles a boolean ONLY where the plan marks it rule-eligible (the plan defines the reachable states), and selects ONLY a plan-defined tier. A rule MAY raise a limit above the base plan value (contract override) but never above the authored maximum.
3. **DETERMINISTIC evaluation with resource bounds and fail-closed behaviour.** Time comes only from an INJECTED decision timestamp; there is no wall-clock, randomness, network, or external lookup, so re-evaluation is idempotent. Evaluation is bounded by a timeout and JSON size / AST-depth / complexity caps. Any error, timeout, bound breach, or unguarded absent-context-field access FAILS CLOSED — the base static decision stands unchanged, the path neither crashes nor blocks, and the failure is audited.
4. **Evaluation runs ONLY on the server issuance/signing path — never in the verifier core, no token-format change.** The engine post-processes the effective entitlement definition BEFORE the snapshot is signed (initial issue and re-issuance/renewal), then issuance signs with the existing E004 signer unchanged. It does NOT run in the offline E001 verifier core and does NOT alter the `LIC1` token layout; an already-issued offline token verifies byte-identically. A separate per-request online (E013 validate-time) evaluation surface — re-deciding on the verify hot path without re-signing — is DEFERRED beyond this epic; usage-driven decisions refresh at the next (re-)issuance, not per validate call.
5. **HIGHEST-PRIORITY-WINS — exactly one effect per entitlement, deterministic tiebreak.** Matching rules evaluate in an explicit integer priority order with a stable rule-id/version tiebreak; exactly ONE matching rule's effect applies per entitlement, and the other matching rules are recorded considered-but-not-applied. There is NO effect chaining, so an overlapping rule set produces a single reproducible outcome with a trivial single-effect bounds check.
6. **Immutable versioning + preview/active/disabled lifecycle + a unified mode-marked append-only audit + dry-run.** A logical rule id groups IMMUTABLE version rows (a content edit INSERTs a new version, never mutating a prior one); status is active | preview | disabled (only enabled active-version rules enforce; a preview rule logs its would-be decision without changing the enforced outcome). Every evaluation — enforced, preview, or dry-run, distinctly MODE-marked — is recorded on ONE tenant-scoped, forced-RLS, append-only `policy_evaluation` trail capturing the fired rule ids + versions, an input snapshot/hash, and the resolved decision (a supplied-context dry-run carries a nullable/synthetic license reference). Dry-run/simulate returns the would-be decision and fired rules without persisting the rule as active or enforcing it. Every rule author/edit/enable/disable/version change and every denied attempt is audited; no secrets or PII.

- **Pros**: Enables admin-configured conditional entitlement decisions (overage tiers, contract overrides, tier toggles) with NO code change and NO arbitrary code execution — the allow-listed non-`eval` evaluator is the security boundary; determinism is provable (injected clock, no time/random/network operator) so re-evaluation at re-issuance is idempotent; every effect is provably bounded to the vendor-authored maximum, so "lift above base" (contract override) and "never grant more than the contract allows" coexist; Principle I is preserved structurally — the engine adjusts pre-sign values via a trusted applier, runs no code in the verifier core, changes no token bytes, and performs no cryptography (reuses the E004 signer unchanged); fail-closed keeps a bad rule from ever crashing or blocking the issuance path; additive to E007 (boolean/limit/metered unchanged, expand-only authored-max/rule-eligible/tier columns); reuses the E005 console session + RBAC + CSRF, tenant-scoped forced RLS, and append-only audit foundation (Principles II/III) with no new auth core and no new crypto; immutable versioning + preview + dry-run + a unified mode-marked trail make every outcome reversible, explainable, and reproducible; the express/validate/sandbox/bound/evaluate/audit contract is directly reusable by the deferred online E013 evaluation surface.
- **Cons**: Usage-driven decisions refresh at (re-)issuance, NOT per validate request — a mid-term usage threshold crossing does not change an already-issued token until it is re-issued (online E013 evaluation is deferred); the sandbox + determinism properties must be PROVEN by tests (sandbox-escape, re-evaluation idempotency, timeout/fail-closed) rather than assumed; the in-house evaluator is code the project owns and must maintain (versus an off-the-shelf library); a new authored per-entitlement maximum is an additional catalog attribute vendors must set to use contract overrides; the structured-JSON authoring surface is less expressive than a free-text expression language (a deliberate MVP scope choice).

### Option B: A free-text CEL expression language

Author rules as free-text CEL (or similar) expressions parsed and evaluated by a CEL engine.

- **Pros**: CEL is a mature, sandboxed, non-Turing-complete expression language with a rich standard library; a single text field is expressive and familiar to power users.
- **Cons**: A free-text editor needs a full parser plus a larger authoring UI and a text-safety-lint surface (rejecting disallowed identifiers/functions in free text is harder to make airtight than an operator allow-list over structured JSON), enlarging the attack and validation surface for the MVP. A structured-JSON condition with a fixed operator allow-list makes the security boundary the allow-list itself (nothing outside it is even expressible) and is sufficient to author/validate/test the target rules; a text-expression editor is a documented later enhancement. Rejected for the MVP.

### Option C: Unrestricted `json-logic-js`

Use the off-the-shelf `json-logic-js` library with its full operator set.

- **Pros**: A ready-made, widely used JSONLogic implementation; no evaluator to build; structured-JSON authoring out of the box.
- **Cons**: Its full operator set is far larger than a licensing decision needs and includes operators that complicate determinism and bounds guarantees; the library does not enforce the project's resource bounds (size/depth/complexity/timeout) or the exact minimized field schema, so the security-critical guarantees would sit outside the project's control. An in-house allow-listed JSONLogic-SUBSET evaluator exposes only the operators the decision needs, owns the determinism (no time/random operator) and the resource bounds directly, and adds no runtime dependency on the eval path — the safest choice for a licensing server. Rejected.

### Option D: A Node `vm`/`vm2` or `eval`/`Function` sandbox

Evaluate rule expressions as JavaScript inside a Node `vm`/`vm2` context or via `eval`/`Function`.

- **Pros**: Maximally expressive — any JavaScript expression is a rule; no evaluator to design.
- **Cons**: `vm`/`vm2`/`eval`/`Function` are NOT a security boundary — `vm` is explicitly documented as not a security mechanism, `vm2` has a history of sandbox-escape CVEs, and `eval`/`Function` execute arbitrary code by definition. Any of these would place an attacker-influenceable arbitrary-code path inside the licensing control plane, which is the exact outcome the epic forbids. HARD REJECT — non-negotiable.

### Option E: Online E013 per-request evaluation in the MVP

Evaluate rules on the E013 validate/heartbeat hot path per request, re-deciding entitlements online without re-signing the token.

- **Pros**: Usage-driven decisions (e.g. an overage tier crossing) take effect immediately for a connected client, without waiting for re-issuance.
- **Cons**: Puts the policy engine on the VERIFY hot path — every validate call would run rule evaluation, coupling enforcement latency to evaluation cost and expanding the online enforcement surface, and it needs a second evaluation entry point before the issuance-time one is even proven. Evaluating at issuance ONLY keeps the engine off the verify hot path, makes determinism trivial (the context is frozen at issue time), and leaves the offline token + verifier untouched; the express/validate/sandbox/bound contract this ADR fixes is exactly what a future online surface reuses. DEFERRED beyond this epic, not refused permanently.

### Option F: The plan's own value as the hard maximum

Bound every effect at the base plan value for the entitlement (a rule may only reduce toward, or restore up to, the plan value — never exceed it).

- **Pros**: The simplest possible ceiling — "a rule can never grant more than the plan sells"; no new catalog attribute to author.
- **Cons**: Guts the primary contract-override use case — a contract override that LIFTS a limit for one customer above the base plan value is impossible if the plan value is the hard cap, so the epic's headline scenario cannot be expressed. A separately-authored per-entitlement maximum (≥ base) lets a rule raise the effective value above base up to that authored bound while staying provably bounded — "lift above base" and "provably bounded" both hold. Rejected.

### Option G: Effect chaining (apply multiple matching rules in sequence)

Let every matching rule's effect apply in priority order, each operating on the previous rule's adjusted value.

- **Pros**: More expressive — several rules can compose (e.g. one lifts a limit, another selects a tier) on the same entitlement.
- **Cons**: Order-dependent and harder to bound and audit — the final value depends on the full applied sequence, the bounds check must hold across every intermediate step, and the audit must reconstruct a chain rather than a single fired rule. HIGHEST-PRIORITY-WINS (exactly one effect per entitlement, others recorded considered-not-applied) yields a single reproducible outcome with a trivial single-effect bounds check and a one-line audit, and it is sufficient for the target scenarios. Rejected.

### Option H: Free effect mutation (a rule mutates the decision directly)

Let a rule mutate the entitlement decision (or other state) directly rather than returning a bounded typed descriptor.

- **Pros**: Maximally flexible — a rule can express any adjustment, not just the three allow-listed effect kinds.
- **Cons**: Unbounded — direct mutation defeats the closed, typed, allow-listed effect surface and the trusted-applier clamp, so there is no single choke point at which to enforce the authored maximum, rule-eligibility, or plan-defined tiers, and a rule could reach state other than the entitlement decision. A closed typed effect descriptor applied by a trusted applier keeps the effect surface allow-listed, typed, range-validated, and clamped in ONE place. Rejected.

## Decision Outcome

Chosen option: **Option A — the composite low-code policy-rule engine: guarded structured-JSON conditions over an in-house allow-listed (non-`eval`) evaluator + a closed typed effect descriptor applied by a trusted applier and clamped to a separately-authored per-entitlement maximum + deterministic, resource-bounded, fail-closed evaluation + issuance/signing-path-only execution (verifier core and token untouched) + highest-priority-wins one effect per entitlement + immutable versioning, preview/active/disabled lifecycle, dry-run, and a unified mode-marked append-only audit** — because it is the only option that lets a Licensing Admin configure conditional entitlement decisions with NO code change while provably admitting no arbitrary code execution, leaving offline verification byte-identical, keeping every effect bounded to a vendor-authored maximum, and reusing the single security/data foundation with no new crypto and no new auth core. Concretely, the model is fixed as:

1. **Guarded structured-JSON conditions + validate-on-author.** A rule condition is a JSONLogic-subset structured JSON expression authored via a structured surface (not free text) and evaluated by an IN-HOUSE evaluator with a fixed pure operator allow-list — NO `eval`/`Function`/`vm`. The operator allow-list IS the security boundary. Every rule is validated BEFORE persisting (shape + operator allow-list + context type-check against an explicit allow-listed field schema + effect-bounds); an invalid/unsafe/out-of-bounds rule is rejected with a distinct reason and never persisted or evaluated.
2. **Closed typed effect descriptor + trusted applier + authored maximum.** A rule returns `{kind: adjust_limit | toggle_boolean | select_tier, target, value}`; it never mutates state. A trusted applier clamps `adjust_limit` to a separately-authored per-entitlement MAXIMUM (a new expand-only E007 attribute, ≥ the base plan value), toggles a boolean ONLY where the plan marks it rule-eligible, and selects ONLY a plan-defined tier. A rule MAY lift a limit above the base plan value (contract override) but NEVER above the authored maximum; an over-bound effect is refused at author time and clamped/skipped at evaluation.
3. **Deterministic, resource-bounded, fail-closed.** Time comes ONLY from an injected decision timestamp; there is no wall-clock/random/network/external-lookup operator, so re-evaluation is idempotent. Evaluation is bounded by a timeout and JSON size / AST-depth / complexity caps. Any error, timeout, bound breach, or unguarded absent-field access FAILS CLOSED to the base static decision — the path neither crashes nor blocks — and the failure is audited.
4. **Issuance/signing-path ONLY.** The engine post-processes the effective entitlement definition BEFORE the snapshot is signed (initial issue + re-issuance/renewal), then issuance signs with the existing E004 signer UNCHANGED. It does NOT run in the E001 verifier core and does NOT change the `LIC1` token format; an already-issued offline token verifies byte-identically. A separate per-request online (E013 validate-time) evaluation surface is DEFERRED; usage-driven decisions refresh at the next (re-)issuance.
5. **Highest-priority-wins.** Matching rules evaluate in explicit integer priority order with a stable rule-id/version tiebreak; exactly ONE effect applies per entitlement, others recorded considered-but-not-applied; NO effect chaining — a single reproducible outcome with a trivial single-effect bounds check.
6. **Immutable versioning + preview/active/disabled + unified mode-marked audit + dry-run.** A logical rule id groups IMMUTABLE version rows (edit = new version); status active | preview | disabled (preview logs its would-be decision without enforcing). Every evaluation — enforced | preview | dry-run, distinctly mode-marked — is recorded on ONE tenant-scoped, forced-RLS, append-only `policy_evaluation` trail (fired rule ids + versions, input snapshot/hash, resolved decision; nullable/synthetic license ref for a supplied-context dry-run). Dry-run/simulate returns the would-be decision without persisting or enforcing. Every rule author/edit/enable/disable/version change and every denied attempt is audited; no secrets or PII.

This ADR fixes the sandboxed, deterministic, low-code policy-rule ENGINE and its bounded issuance-time effect model. It does NOT re-decide the E007 entitlement semantics (extended additively with an authored maximum, boolean rule-eligibility, and tiers), the E008 license lifecycle, the E004 signing-key custody or the E001 verifier core (untouched), or the E005 console session/RBAC/CSRF core (reused) — all consumed unchanged.

## Consequences

### Positive

- Admin-configured conditional entitlement decisions are enabled — overage tiers, contract overrides, and tier-gated toggles — with NO code change and NO arbitrary code execution, closing the gap that E007's static boolean/limit/metered values cannot express (CAP-011).
- Principle I is preserved structurally: the engine adjusts PRE-SIGN values via a trusted applier, runs NO code in the offline verifier core, changes NO token bytes, and performs NO cryptography (it reuses the E004 signer at issuance unchanged) — an already-issued offline token verifies byte-identically.
- No arbitrary code path enters the control plane: the in-house allow-listed (non-`eval`/`vm`) evaluator makes the operator allow-list the security boundary, so nothing outside the allow-list is even expressible, and author-time validation rejects an unsafe rule before it can ever be evaluated.
- Decisions are deterministic and reproducible: an injected clock and a no-time/no-random/no-network operator set make re-evaluation at re-issuance idempotent, and the unified audit records the exact fired rule version + input snapshot so any decision is explainable.
- Every effect is provably bounded: the closed typed descriptor + trusted-applier clamp to a vendor-authored per-entitlement maximum lets a contract override LIFT a limit above base while guaranteeing a rule can never grant more than the authored bound, toggle a non-rule-eligible boolean, or select an undefined tier.
- The single security/data foundation is reused (Principles II/III): the admin surface reuses the E005 console session + RBAC + CSRF, the rule and evaluation tables reuse tenant-scoped forced RLS and the append-only audit pattern, and no new crypto or auth core is introduced; the decision context is minimized (no secret/signing key/PII beyond a pseudonymous reference).
- Rule changes are reversible and outcomes explainable: immutable versioning, a preview (report-only) state, dry-run/simulate, and one unified mode-marked append-only trail support safe staged rollout and full auditability.

### Negative

- Usage-driven decisions refresh at (re-)issuance, NOT per request: a mid-term usage threshold crossing does not change an already-issued token until it is re-issued, because online E013 per-request evaluation is DEFERRED (a disclosed, intentional MVP boundary — the express/validate/sandbox/bound contract is reusable when that surface is built).
- The sandbox and determinism guarantees must be PROVEN, not assumed: a sandbox-escape test (no host state reachable), a re-evaluation idempotency test, and a timeout/fail-closed test are load-bearing acceptance evidence for this decision.
- The in-house allow-listed evaluator is code the project owns and must maintain and security-review, versus delegating to an off-the-shelf library (a deliberate trade for full control over the operator set, determinism, and resource bounds).
- A new authored per-entitlement MAXIMUM is an additional expand-only catalog attribute a vendor must set to use a contract override; the base plan value alone is not the ceiling.

### Neutral

- The evaluation resource bounds (timeout, JSON size / AST-depth / complexity caps), the highest-priority-wins conflict policy configuration, the authored-maximum source, and the specific JSONLogic-subset operator allow-list are operator/config choices WITHIN this model, not separate architectural decisions.
- The structured-JSON authoring surface (not a free-text expression editor and not a rich drag-and-drop builder) is the MVP class fixed by clarify Q4; a text-expression editor and a visual builder are documented later enhancements, not permanent exclusions.
- The metering aggregate (ADR-0013) is a READ-ONLY, `has()`-guarded input to the decision context for usage-driven rules (e.g. an overage tier); this ADR governs the dynamic-decision layer, not the aggregation model it consumes.
- Enforcement of the (now possibly rule-adjusted) entitlement decision on the client/validate path stays E009/E013's responsibility; the engine only adjusts the effective definition before signing.

## Links

- specs/00018-low-code-policy-rules/spec.md — E017 (FR-001..FR-018, US1..US6, SC-001..SC-015); the guarded-condition authoring, validate-on-author, sandboxed deterministic bounded evaluation, issuance-only execution, highest-priority-wins conflict, versioning/preview/dry-run, and unified-audit requirements this ADR fixes the model for.
- specs/00018-low-code-policy-rules/plan.md — the feature-local tradeoffs AD-001..AD-009 (guarded engine, effect model, effect-bound source, evaluation point, conflict resolution, versioning/lifecycle, determinism, evaluation audit, module placement) that instantiate this project-level model.
- src/server/modules/catalog/effective.ts — the E008 issuance `getEffectivePlanDefinition` pre-sign hook point the engine post-processes before the snapshot is signed; it carries no dynamic policy logic itself (that is E017).
- src/server/modules/signing/signer.ts — the E004 signer reused UNCHANGED at issuance; the engine performs no cryptography and does not touch the signer, the token bytes, or the E001 verifier core.
- migrations/0012_usage_metering.sql — the highest existing migration; the new `0013_policy_rules.sql` (policy_rule + policy_evaluation + entitlement rule-bound columns) lands sequentially after it.
- ADR-0013 (Usage-Metering Ingestion and Aggregation Model) — the STATIC metering aggregate this decision consumes as read-only decision context; ADR-0014 is the DYNAMIC-DECISION layer over ADR-0013's and E007's static entitlement values.
- ADR-0003 (Signing-Key Custody & Scope) — the per-product Ed25519 signer this decision reuses unchanged at issuance with no new key custody and no new crypto.
- ADR-0004 (Multi-Tenancy Isolation Model) — the tenant-scoping (forced RLS, cross-tenant → not found, unset tenant GUC → zero rows) the policy_rule and policy_evaluation tables inherit.
- ADR-0005 (Architecture Style — Modular Monolith) — the module seams the new `policy` module and its evaluation seam (consumed by E008 issuance) slot into.
- ADR-0008 (Admin Console Human Authentication — Server-Side Cookie Sessions) — the console session + RBAC + double-submit CSRF the rule admin surface reuses.
- PRD CAP-011 (low-code policy rules); the E007 entitlement model this ADR extends additively (authored maximum, boolean rule-eligibility, tiers), the E008 issuance path it hooks pre-sign, the E016 usage aggregate and E008 license it consumes as read-only context, and the E013 online evaluation surface it defers; project-instructions.md Principle I (offline-first / signing key never exposed / single crypto core), Principle II (multi-tenant isolation + RBAC), and Principle III (single security core, fully audited).
</content>
</invoke>
