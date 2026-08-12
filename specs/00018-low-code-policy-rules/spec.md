---
feature_branch: "00018-low-code-policy-rules"
created: "2026-08-11"
input: "E017"
spec_type: "product"
spec_maturity: "clarified"
epic_id: "E017"
epic_sources: "{PRD:CAP-011}"
---

# Feature Specification: Low-Code Policy Rules

**Feature Branch**: `00018-low-code-policy-rules`
**Created**: 2026-08-11
**Status**: Draft
**Spec Type**: product
**Spec Maturity**: clarified
**Epic ID**: E017
**Epic Sources**: {PRD:CAP-011}
**Product Document**: specs/prd.md

## Problem Statement *(mandatory)*

Entitlements today are STATIC — a plan attaches a fixed boolean/limit/metered value (E007) that is snapshotted verbatim into a license (E008). But real contracts need *conditional* entitlement decisions: an overage tier that unlocks at a usage threshold, a contract override that lifts a limit for one customer, a feature toggled only for a plan tier. Encoding each of these as a bespoke plan or a code change is slow and error-prone, and vendors have asked to configure such logic themselves. This feature adds a **low-code policy-rule layer**: a Licensing Admin authors guarded `when → then` rules — no free-form code — that dynamically adjust an entitlement decision within safe bounds, evaluated by a sandboxed, deterministic engine on the control plane, without ever changing offline verification or executing arbitrary code.

## Scope *(mandatory)*

### Included

- Rule authoring: a Licensing Admin defines a policy rule as a guarded condition (a sandboxed expression over a bounded, read-only decision context) plus a bounded, allow-listed effect on an entitlement decision, on the admin surface (no free-form code).
- Validate-on-author: every rule is parsed, type-checked against the context schema, safety-linted, and effect-bounds-checked before it can be saved — an unparseable, unsafe, or out-of-bounds rule is rejected and never persisted or evaluated.
- Deterministic, bounded evaluation: active rules evaluate in a deterministic priority order against the decision context and apply a bounded effect (adjust a numeric limit within the authored maximum, toggle a boolean, select an overage tier); the same context always yields the same decision.
- Sandboxed runtime: rule evaluation cannot execute arbitrary code, perform I/O, reach host/globals, or exceed resource bounds (timeout, size/depth/complexity); a rule that errors or times out fails closed to the base (static) decision.
- Lifecycle: rules are immutably versioned (edit = new version), can be enabled/disabled, and support a preview (report-only) state distinct from active (enforced) — for safe rollout.
- Dry-run / simulate: an admin tests a rule (or rule set) against a supplied or real context and sees the resulting decision without persisting or enforcing it.
- Auditability: every evaluation (enforced, preview, or dry-run — distinctly marked) is recorded append-only with the fired rule ids/versions, an input snapshot/hash, and the resolved decision.
- Tenant isolation, admin RBAC + CSRF, and minimized (no-secret/no-PII) decision context on the rule surface.

### Excluded

- Free-form code / general scripting — rules are guarded expressions in a sandboxed language only; arbitrary code execution is a non-goal and a hard security boundary (no `eval`/`vm`/host access).
- Changing offline verification or the signed token format — E017 runs on the server control plane only; it never runs in the offline verifier core and does not alter the LIC1 token layout. An already-issued offline token keeps verifying exactly as before (Principle I).
- New cryptography or signer changes — the policy engine performs no cryptography; issuance continues to sign the (now possibly rule-adjusted) entitlement snapshot with the existing E004 signer.
- Effects beyond the entitlement decision — a rule cannot mutate licenses, users, billing, keys, or any state other than the bounded entitlement-decision adjustment it returns; enforcement of the adjusted decision (activation/validate) remains E009/E013's job.
- A free-text expression-language editor or a rich drag-and-drop builder — the MVP authors rules as structured JSON conditions (JSONLogic-style) via a structured surface sufficient to author/validate/test; a text-expression editor and a visual builder are later enhancements.
- Per-request online (E013 validate-time) evaluation — DEFERRED; the MVP evaluates rules only on the issuance/signing path (initial issue and re-issuance/renewal), not on the validate hot path (FR-008).
- Granting an entitlement the plan does not define, or raising a limit above the authored per-entitlement MAXIMUM — a rule may raise above the base plan value (a contract override) only up to the vendor-authored maximum (FR-007); it can never exceed that authored bound or toggle a boolean the plan does not mark rule-eligible.

### Edge Cases & Boundaries

- A rule expression that references a host/global, calls `eval`/`require`/`process`, or uses a disallowed construct → rejected at author time; it can never be persisted or evaluated.
- A rule whose effect would exceed the authored maximum (raise a limit above the authored per-entitlement max, grant an undefined entitlement, or toggle a non-rule-eligible boolean) → rejected at author time or clamped/refused at evaluation, never applied out of bounds.
- A rule that errors, times out, or exceeds a resource bound at evaluation → fails closed: the base static decision stands, nothing crashes, and the failure is audited.
- A rule referencing a context field that is absent (e.g. usage aggregate unavailable) → the rule's own guard (`has()`-style) governs; an unguarded missing-field access fails closed for that rule, not the whole decision.
- Two rules matching the same entitlement with conflicting effects → resolved deterministically by explicit priority with a stable tiebreak (rule id/version); the outcome is reproducible.
- Re-evaluating the same rule set against the same context → identical decision (deterministic; time comes only from the injected decision timestamp, never wall-clock/random).
- A preview (report-only) rule → logs its would-be decision but does not change the enforced outcome; a dry-run → returns a decision without persisting or enforcing.
- Editing an active rule → creates a new immutable version; in-flight/prior decisions reference the version that evaluated them (auditable).
- Cross-tenant: an admin from one tenant can neither see, author, nor evaluate another tenant's rules; a cross-tenant rule reference resolves to not found.
- A disabled rule → never evaluates; an active-but-non-matching rule → no effect.
- An entitlement's authored maximum (`rule_max`) LOWERED below a previously-applied effect value → the effect is re-clamped to the NEW lower maximum at the next (re-)issuance; every issuance evaluates fresh against the current authored bound, so a prior higher decision is never reused (deterministic, FR-007/INV-4).

## User Scenarios & Testing *(mandatory for product specs only)*

### User Story 1 - Author and validate a guarded rule (Priority: P1) 🎯 MVP

A Licensing Admin opens the rule surface and authors a policy rule: a guarded condition over the decision context (e.g. "when the license's plan tier is enterprise and monthly usage exceeds 10,000") and a bounded effect (e.g. "set the `api_calls` limit to 50,000"). Before the rule is saved, the system validates it — parses the expression, type-checks it against the allowed context, safety-lints it for any unsafe construct, and checks the effect is within bounds — and rejects anything unparseable, unsafe, or out-of-bounds with a clear reason, so a bad rule can never reach evaluation.

**Why this priority**: Author-time validation is the security and correctness gate — without it, an unsafe or malformed rule could be persisted and later break evaluation. It is the foundation every other story builds on and directly satisfies "an admin defines a guarded rule."

**Independent Test**: Author a well-formed rule and confirm it saves; author a rule using a disallowed construct (arbitrary-code / host access) and confirm it is rejected; author a rule whose effect exceeds the authored maximum and confirm it is rejected — all before any evaluation occurs.

**Acceptance Scenarios**:

1. **Given** the admin rule surface, **When** an admin submits a syntactically valid, safe, in-bounds `when → then` rule, **Then** it is validated and saved as an authorable rule.
2. **Given** a rule whose condition contains a disallowed/unsafe construct (arbitrary code, host/global/IO access), **When** the admin submits it, **Then** it is rejected with a distinct reason and NOT persisted.
3. **Given** a rule whose effect would exceed the authored maximum or target an undefined entitlement, **When** the admin submits it, **Then** it is rejected with a distinct reason and NOT persisted.

### User Story 2 - A rule dynamically adjusts an entitlement decision, deterministically and within bounds (Priority: P1) 🎯 MVP

When an entitlement decision is resolved on the control plane, the tenant's active rules evaluate in deterministic priority order against the decision context, and a matching rule applies its bounded effect to the decision — adjusting a limit, toggling a boolean, or selecting an overage tier. The adjusted decision never exceeds the authored maximum, and evaluating the same rules against the same context always produces the same decision.

**Why this priority**: This is the core value — a rule that actually changes an entitlement outcome. Determinism and the authored-maximum bound are what make the change safe and trustworthy; directly satisfies "a guarded rule changes an entitlement decision" + "outcomes are deterministic."

**Independent Test**: Define a rule "when usage > 10,000 then set `api_calls` limit to 50,000"; resolve the decision with a matching context and confirm the limit is 50,000; resolve with a non-matching context and confirm the base value stands; re-resolve the matching context and confirm an identical decision; confirm an effect above the authored maximum is clamped/refused.

**Acceptance Scenarios**:

1. **Given** an active rule whose condition matches the decision context, **When** the entitlement decision is resolved, **Then** the rule's bounded effect is applied and the adjusted decision is returned.
2. **Given** the same rules and the same context, **When** the decision is resolved twice, **Then** both evaluations return the identical decision (deterministic).
3. **Given** a rule whose effect would exceed the authored maximum for the entitlement, **When** it is applied, **Then** the decision is clamped to the authored maximum — a rule can never grant more than the vendor-authored bound (such an effect is already refused at author time, FR-002; the evaluation clamp is defense-in-depth).
4. **Given** two active rules matching the same entitlement with conflicting effects, **When** the decision is resolved, **Then** the deterministic priority + stable tiebreak selects one reproducible outcome.

### User Story 3 - Sandboxed evaluation that cannot execute arbitrary code and fails closed (Priority: P1) 🎯 MVP

Rule evaluation runs in a strict sandbox: a rule cannot execute arbitrary code, perform I/O, reach host globals, or run unbounded — evaluation is bounded by a timeout and expression size/depth/complexity limits. A rule that errors, times out, or exceeds a bound fails closed — the base static entitlement decision stands, nothing crashes or blocks the decision path, and the failure is audited.

**Why this priority**: Security-critical and non-negotiable — a policy engine that can execute arbitrary code or crash the decision path is unacceptable in a licensing server. Directly satisfies "rule evaluation is sandboxed and cannot execute arbitrary code."

**Independent Test**: Attempt to author/evaluate expressions that call `eval`/`require`/`process`, access a global, or loop unboundedly and confirm each is rejected at author time or fails closed at evaluation with no side effect; confirm a well-formed rule evaluates within the resource bounds and a deliberately slow/over-limit rule times out to the base decision.

**Acceptance Scenarios**:

1. **Given** an expression attempting arbitrary code / host / I/O access, **When** it is evaluated (or authored), **Then** it is refused with no side effect — no host state is read or written.
2. **Given** a rule that errors or exceeds the evaluation timeout / size / depth bound, **When** the decision is resolved, **Then** the base static decision is returned unchanged, the decision path does not crash or block, and the failure is audited.
3. **Given** a well-formed rule within the resource bounds, **When** it is evaluated, **Then** it produces its decision within the configured limits.

### User Story 4 - Dry-run / simulate a rule before activating it (Priority: P2)

Before turning a rule on, an admin tests it: they run the rule (or the tenant's rule set) against a supplied sample context or a real license/plan context and see exactly what decision it would produce — which rules fired and the resulting adjustment — without persisting the rule as active or enforcing the outcome on any live license.

**Why this priority**: Safe rollout — admins need to see a rule's effect before it affects customers; valuable but the P1 authoring/evaluation loop works without it, and a preview state (US5) partially overlaps.

**Independent Test**: Author a candidate rule, dry-run it against a sample context, and confirm the returned decision and fired-rules explanation match expectation while no live decision or rule state changed.

**Acceptance Scenarios**:

1. **Given** a candidate or active rule, **When** an admin dry-runs it against a supplied/real context, **Then** the system returns the would-be decision and which rules fired, without persisting or enforcing anything.
2. **Given** a dry-run, **When** it completes, **Then** no live entitlement decision, license, or rule enforcement state is changed.

### User Story 5 - Versioned, auditable rule lifecycle (Priority: P2)

Rules evolve safely: editing a rule creates a new immutable version (the prior version is never mutated), rules can be enabled/disabled, and a rule can run in preview (report-only) — logging its would-be decision without enforcing — before being made active. Every evaluation is recorded append-only with the fired rule ids/versions, an input snapshot/hash, and the resolved decision, so any outcome is explainable and reproducible.

**Why this priority**: Operability and trust — versioning + audit make rule changes reversible and outcomes explainable, and preview enables staged rollout; important, but the MVP can enforce rules without the full lifecycle.

**Independent Test**: Author a rule, put it in preview and confirm it logs a would-be decision without changing the enforced outcome; edit it and confirm a new version is created while the old version is retained; resolve a decision and confirm the audit records which rule versions fired and the decision.

**Acceptance Scenarios**:

1. **Given** an active rule, **When** an admin edits it, **Then** a new immutable version is created and the prior version is retained (never mutated).
2. **Given** a preview (report-only) rule, **When** decisions are resolved, **Then** the rule's would-be effect is logged but the enforced decision is unchanged.
3. **Given** any evaluation, **When** it completes, **Then** an append-only audit entry records the fired rule ids + versions, an input snapshot/hash, and the resolved decision.

### User Story 6 - Deterministic conflict resolution and precedence (Priority: P2)

When several rules could affect the same entitlement, the admin controls the order with an explicit priority, and the engine resolves conflicts deterministically — higher priority wins, with a stable tiebreak — so overlapping rules never produce a random or order-dependent outcome, and an author-time lint warns about overlapping or unreachable rules.

**Why this priority**: Correctness at scale — as rule sets grow, deterministic precedence prevents surprising outcomes; the P1 stories already require deterministic ordering, so this deepens rather than blocks the MVP.

**Independent Test**: Define two overlapping rules with different priorities targeting the same entitlement, resolve a matching context, and confirm the higher-priority rule's effect wins reproducibly; author an overlapping/unreachable rule and confirm the lint flags it.

**Acceptance Scenarios**:

1. **Given** multiple rules matching one entitlement with distinct priorities, **When** the decision is resolved, **Then** the highest-priority rule's effect is applied and the result is identical on every re-evaluation.
2. **Given** rules with the same priority matching one entitlement, **When** the decision is resolved, **Then** a deterministic tiebreak (rule id/version) yields one reproducible outcome.
3. **Given** an overlapping or unreachable rule, **When** it is authored, **Then** the system surfaces a lint warning.

## Requirements *(mandatory)*

### Functional Requirements *(product specs only)*

- **FR-001**: System MUST let a Licensing Admin author a policy rule — a guarded condition (a sandboxed **structured-JSON** condition, JSONLogic-style, assembled via a structured surface — NOT a free-text expression editor) over the bounded decision context, plus a bounded, allow-listed effect on an entitlement decision — on the admin surface, tenant-scoped, with no free-form code. Access control (console session + RBAC admin + CSRF) is per FR-016.
- **FR-002**: System MUST validate every rule at author time BEFORE persisting it — validate the structured JSON condition (shape + allowed operators), type-check it against the allow-listed context schema, safety-lint it (reject any operator/field/construct outside the allow-list, or that could execute arbitrary code, reach host/globals/I-O, or exceed resource bounds), and check the effect is within bounds — and MUST reject an invalid/unsafe/out-of-bounds rule with a distinct reason, never persisting or evaluating it.
- **FR-003**: System MUST restrict a rule's effect to a closed, allow-listed, typed set — adjust a numeric entitlement limit (bounded by the authored per-entitlement maximum, FR-007), toggle a boolean entitlement ONLY where the plan marks it rule-eligible (the plan defines the reachable states), or select an overage tier from the plan-defined tiers — with range-validated values; a rule-eligible boolean MAY be driven to either of its plan-defined reachable states (on or off). A rule MUST NOT free-mutate arbitrary state, and the rule returns an effect DESCRIPTOR that a trusted applier applies to the decision.
- **FR-004**: System MUST evaluate rules against a BOUNDED, READ-ONLY decision context — plan/entitlement values (E007), license claims (E008), usage aggregates (E016 when available), and an INJECTED decision timestamp — exposing no other host, global, secret, or PII. The referenceable context MUST be an EXPLICIT allow-listed field schema (the author-time type-check target and the minimization boundary); usage (E016) fields MUST be `has()`-guarded, and an unguarded access to an absent field fails that rule closed (FR-010), never the whole decision. The assembled context is itself BOUNDED — a maximum serialized size, JSON nesting depth, and field count (NEW-CONFIG) — so neither the real nor a dry-run-supplied context (FR-020) can be oversized.
- **FR-005**: System MUST make evaluation DETERMINISTIC — the same context yields the same decision; a rule MUST NOT use wall-clock, randomness, network, or any lookup outside the supplied context (time comes only from the injected decision timestamp), so re-evaluation is idempotent. The recorded `input_hash` (and any `input_snapshot`) MUST be computed over a CANONICAL serialization of the decision context — stable key ordering and normalized value encoding — so an identical decision context deterministically reproduces the identical hash (FR-014, SC-003, data-model INV-12).
- **FR-006**: System MUST evaluate matching rules in a deterministic order — an explicit integer priority with a stable tiebreak (rule id/version) — and apply the conflict-resolution policy **HIGHEST-PRIORITY-WINS**: exactly ONE matching rule's effect applies per entitlement; other matching rules are recorded as considered-but-not-applied — so an overlapping rule set produces a single reproducible outcome (no effect chaining).
- **FR-007**: System MUST bound every applied effect to a separately-authored, per-entitlement MAXIMUM (the "ceiling") — a vendor-authored value that is ≥ the base plan value for that entitlement. A rule MAY raise the effective limit above the base plan value (a contract override) but MUST NOT exceed the authored maximum, MUST NOT toggle a boolean the plan does not mark rule-eligible, and MUST NOT select an undefined tier; an out-of-bounds effect is REFUSED at author time (FR-002, the primary guarantee since effect values are static literals) and, as defense-in-depth, CLAMPED to the maximum at evaluation — never applied beyond the authored bound.
- **FR-008**: System MUST run rule evaluation ONLY on the server control plane AT ISSUANCE — evaluating rules against the decision context and baking the adjusted effective entitlement definition into the snapshot BEFORE it is signed into the license token (this includes any re-issuance/renewal that re-signs the snapshot) — and MUST NOT run in the offline verifier core or change the signed token format; an already-issued offline token verifies unchanged. A SEPARATE per-request online (E013 validate-time) evaluation surface — re-deciding on the validate hot path without re-signing — is DEFERRED beyond this epic; usage-driven decisions update at the next (re-)issuance, not per validate call.
- **FR-009**: System MUST fully sandbox rule evaluation — no arbitrary code execution (no `eval`/`Function`/`vm`/host access), no I/O, no side effects — and MUST enforce resource bounds (an evaluation timeout and expression size / AST-depth / complexity caps); a rule exceeding a bound is rejected at author time (FR-002) and fails closed at runtime (FR-010).
- **FR-010**: System MUST fail closed on any evaluation error, timeout, resource-bound breach, or unguarded missing-context-field access — the base static entitlement decision (E007) stands unchanged, the decision path neither crashes nor blocks, and the failure is audited (FR-014).
- **FR-011**: System MUST version policy rules immutably — an edit creates a NEW version and never mutates a prior version — and MUST support enabling/disabling; only enabled rules of the active version evaluate, and a disabled rule never evaluates. A version row's CONTENT (condition, effect, priority, target entitlement/plan, rule_key, version, author, created_at) MUST be immutable after insert — `status` (with its `updated_at` timestamp) is the ONLY mutable column, and the persistence layer MUST restrict every UPDATE to `status`/`updated_at` (data-model INV-2); a content change is always a new version, never an in-place mutation of a prior one.
- **FR-012**: System MUST support a PREVIEW (report-only) rule state — the rule evaluates and logs its would-be decision WITHOUT changing the enforced outcome — distinct from an ACTIVE (enforced) state, so a rule can be rolled out safely. A preview rule is ranked and decided INDEPENDENTLY of the enforced active set — it never displaces or alters the winning active rule — and the logged would-be decision is the effect the preview rule would apply if it were the winning active rule for its entitlement.
- **FR-013**: System MUST let an admin DRY-RUN / simulate a rule (or the tenant's rule set) against a supplied or real decision context and return the resulting decision (which rules fired and the adjusted decision) WITHOUT persisting the rule as active or enforcing the outcome on any live license.
- **FR-014**: System MUST record every rule evaluation on ONE unified, tenant-scoped, RLS-protected, append-only trail — enforced, preview, and dry-run distinctly MODE-marked (a supplied-context dry-run carries a nullable/synthetic license reference) — capturing the fired rule id + version, the considered-but-not-applied rule ids + versions (FR-006), a canonical `input_hash` (plus an optional snapshot, FR-005), and the resolved decision, so any outcome is explainable and reproducible; and MUST record every rule author/edit/enable/disable/version change on the audit trail; all without secrets or PII. An audit-write failure during evaluation MUST itself fail closed WITHOUT blocking issuance — the base static decision stands and the token is still issued, and the audit-persistence failure is surfaced to operational logging, never to the signing path (FR-010, SC-020). The append-only trail MUST be bounded by a configurable retention window pruned on the owner role (NEW-CONFIG), so the audit does not grow unbounded. (Security-event auditing of denied/CSRF-failed attempts is FR-016.)
- **FR-015**: System MUST isolate policy rules and evaluations by tenant, fail-closed (forced RLS): an admin, rule, or evaluation from one tenant can neither read, author, nor evaluate against another tenant's rules or context, and a cross-tenant rule reference resolves to not found.
- **FR-016**: System MUST protect the rule admin surface with the console session + RBAC (admin authors/edits/enables; viewer reads) and a double-submit CSRF token (fail-closed 403 on missing/mismatched), and MUST audit each denied or CSRF-failed attempt as a security event (the author/edit/enable/disable/version lifecycle trail is owned by FR-014).
- **FR-017**: System MUST minimize the decision context and all rule/audit outputs — exposing only the entitlement/plan/license/usage fields needed for a decision, never a secret, signing key, or PII beyond a pseudonymous reference — and a rule expression or audit entry MUST NOT be able to read or emit a secret.
- **FR-018**: System MUST introduce NO new cryptography and NO signing surface — the policy engine performs no cryptography and does not touch the verifier core; issuance continues to sign the (possibly rule-adjusted) entitlement snapshot with the existing E004 signer, and offline verification is unchanged (Principle I).
- **FR-019**: System MUST bound the total per-issuance evaluation cost so an unbounded rule set cannot slow or DoS the signing path (bounds FR-008/FR-009): it MUST enforce three distinct, config-sourced caps (NEW-CONFIG): a per-ENTITLEMENT active/preview rule-set size cap, a per-TENANT total active/preview rule-set size cap, and a per-ISSUANCE maximum number of rules evaluated per decision. An authoring action that would push the per-entitlement or per-tenant live rule set beyond its cap is REJECTED at author time (`rule_set_limit_exceeded`, FR-002). An evaluation that would exceed the per-issuance evaluated-rule cap FAILS CLOSED for the AFFECTED ENTITLEMENT ONLY — its base static decision stands (consistent with the per-entitlement fail-closed of FR-010, NOT a whole-issuance revert) — and the breach is audited (FR-014).
- **FR-020**: System MUST validate a DRY-RUN SUPPLIED decision context against the SAME explicit allow-listed context-field schema and the SAME size / JSON-depth / field-count bounds as the real assembled context (FR-004) BEFORE evaluating it — an out-of-schema, oversized, or over-depth supplied context is REJECTED (`validation_error`) and never evaluated, so an admin cannot inject a malicious or oversized context to escape the evaluation resource bounds or bypass FR-002/FR-009.
- **FR-021**: System MUST treat setting or raising a per-entitlement authored MAXIMUM (the ceiling, FR-007) — and marking an entitlement rule-eligible or defining its select-tier options — as an ADMIN-ONLY, CSRF-protected, AUDITED catalog action (FR-016), because the authored maximum is the trust anchor for the effect bound. The authored maximum MUST be validated as ≥ the base plan value for that entitlement AND within any configured absolute per-entitlement cap (NEW-CONFIG); a non-admin change or an out-of-range value is REFUSED, so the ceiling can never be raised arbitrarily to defeat the bound (FR-007, data-model INV-4).

### Key Entities *(include for product or technical specs if feature involves data)*

- **Policy rule** *(new)*: a tenant-scoped, immutably-versioned rule attached to a target (an entitlement key and/or plan/product scope). Attributes: owning tenant, target entitlement/plan scope, a guarded condition expression (sandboxed, validated at author time), a bounded typed effect descriptor (adjust-limit | toggle-boolean | select-tier, with range-validated value), an integer priority, a version, a status (active | preview | disabled), created/updated + author. Invariant: an edit creates a new version; a rule may only take effect within the authored maximum for its target entitlement.
- **Policy evaluation / decision audit** *(new)*: an append-only record of one evaluation. Attributes: owning tenant, the license/plan/entitlement it decided, the fired rule id + version, the CONSIDERED-BUT-NOT-APPLIED rule ids + versions (FR-006), a canonical `input_hash` (plus optional snapshot), the resolved (adjusted) decision, the mode (enforced | preview | dry-run), and a timestamp. Immutable; the reproducibility/explainability record; bounded by a configurable retention window pruned on the owner role (FR-014).
- **Entitlement** (E007, read-only context): the static plan/entitlement values (boolean / integer_limit / metered) and the authored maximum a rule adjusts within; a rule never redefines the entitlement, only its resolved value within bounds.
- **License** (E008, read-only context): the license claims (plan, product, customer reference, expiry) a rule may condition on; a rule adjusts the license's entitlement decision, never the license itself.
- **Usage aggregate** (E016, read-only context, when available): the per-license/entitlement/period aggregate a usage-driven rule (e.g. overage tier) may condition on.

## Assumptions & Risks *(mandatory)*

### Assumptions

- Policy-rule evaluation is a SERVER-SIDE control-plane capability; it does not run on the client or in the offline verifier core, and it does not change the signed LIC1 token format — the offline verification path (E001) is untouched (Principle I).
- The bounded decision context is assembled server-side from E007 (plan/entitlement), E008 (license claims), and E016 (usage aggregates when available), plus an injected decision timestamp for determinism.
- The rule admin surface uses the console session + RBAC + CSRF (E005), consistent with the catalog/billing/lease/usage admin surfaces; only an admin authors/edits rules.
- The guarded engine is a sandboxed, non-Turing-complete STRUCTURED-JSON evaluator (JSONLogic-style — conditions are structured JSON, not free text) with no host access; the spec fixes the SAFETY and DETERMINISM properties, and the JSON-structured authoring class, leaving the specific library to Plan.
- A rule's effect is applied by a trusted server-side applier to the entitlement decision and is always clamped to the authored per-entitlement maximum (≥ the base plan value); a rule cannot grant more than that authored bound.

### Risks

- **Sandbox escape / arbitrary code execution** *(likelihood: low, impact: high)*: a naive expression evaluator (`eval`/`Function`/`vm`) could execute arbitrary code — mitigated by a non-eval guarded engine, author-time safety-lint, and strict resource bounds, proven by a security test that no host state is reachable.
- **Non-deterministic or unbounded evaluation** *(likelihood: medium, impact: high)*: wall-clock/random/network in a rule, or an unbounded expression, would break reproducibility or the decision path — mitigated by an injected clock, forbidden nondeterministic functions, resource bounds, and fail-closed evaluation, proven by re-evaluation and timeout tests.
- **Over-permissive effect** *(likelihood: medium, impact: medium)*: a rule that lifts a limit beyond the authored maximum would let a customer exceed what they bought — mitigated by the closed, typed, ceiling-clamped effect surface and author-time effect-bounds validation.

## Implementation Signals *(mandatory)*

- `NEW-ENTITY` — `policy_rule` (versioned, tenant-scoped, guarded condition + bounded effect) and `policy_evaluation` (append-only decision audit).
- `NEW-API` — rule admin CRUD + enable/disable/version + dry-run/simulate REST behind the console session; an internal evaluation seam consumed by E008 issuance ONLY (per-request online E013 evaluation is deferred, FR-008; not a public runtime endpoint).
- `NEW-UI` — admin "Policy Rules" surface (author/validate a guarded rule, set priority, preview/active, dry-run, view versions) within the Catalog/Licensing area.
- `MIGRATION` — new `policy_rule` + `policy_evaluation` tables (tenant-scoped, forced RLS, immutable rule versioning, append-only evaluation audit). Sequential migration after the latest existing migration.
- `NEW-CONFIG` — evaluation resource bounds (timeout, JSON condition size / depth / complexity caps), the decision-context size / JSON-depth / field-count caps (FR-004/FR-020), the per-ENTITLEMENT and per-TENANT maximum active/preview rule-set size and the per-ISSUANCE maximum number of rules evaluated per decision (three distinct caps, FR-019), the conflict-resolution policy (highest-priority-wins), the per-entitlement authored-maximum (ceiling) source and its absolute per-entitlement cap (FR-021), a BOUNDED `policy_evaluation` audit retention window (a configurable age after which an owner-role prune removes expired rows, mirroring the E014/E016 append-only ledgers, FR-014), and the structured-JSON (JSONLogic-style) engine library (Plan-level).
- `NEW-WORKER` — a `policy_evaluation` retention-prune worker (fail-open, time-driven, owner-role, configurable retention window, synthetic-actor audit — mirroring the E014/E016 append-only-ledger prune, FR-014). Rule EVALUATION itself is synchronous on the control-plane issuance path and its audit is written in-line (no worker); only the audit retention prune is a background job.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [US1]: An admin authors a well-formed, safe, in-bounds guarded rule and it is saved; an unsafe (arbitrary-code/host-access) rule and an over-ceiling-effect rule are each rejected with a distinct reason and not persisted.
- **SC-002** [US2]: A rule whose condition matches the context applies its bounded effect and changes the entitlement decision (e.g. the limit becomes the rule's value); a non-matching context leaves the base decision unchanged.
- **SC-003** [US2]: Evaluating the same rule set against the same context twice returns the identical decision, the identical fired rule, AND the identical `input_hash` (deterministic; the hash is computed over a canonical serialization of the context).
- **SC-004** [US2]: An adjust-limit effect at or below the authored per-entitlement maximum is applied as-is; the adjusted decision never grants more than the authored maximum (the raise-above-base and boolean cases are SC-015).
- **SC-005** [US3]: An expression attempting arbitrary code / host / I/O access is refused with no host state read or written; a well-formed rule evaluates within the configured resource bounds.
- **SC-006** [US3]: A rule that errors, times out, or breaches a resource bound leaves the base static decision unchanged, does not crash or block the decision path, and is audited.
- **SC-007** [US4]: An admin dry-runs a rule against a supplied/real context and receives the would-be decision and fired-rules explanation, while no live decision, license, or rule-enforcement state changes.
- **SC-008** [US5]: Editing a rule creates a new immutable version with the prior version retained; a preview rule logs its would-be decision without changing the enforced outcome.
- **SC-009** [US5]: Every evaluation records an append-only audit entry with the fired rule id + version, the considered-but-not-applied rule ids + versions, a canonical `input_hash` (plus optional snapshot), and the resolved decision, distinctly marking enforced vs preview vs dry-run.
- **SC-016** [US2]: Rule evaluation occurs on the issuance/signing path (initial issue and re-issuance/renewal) and produces NO per-validate re-decision — an offline token's entitlements are its issuance-time snapshot, and no rule runs on the E013 validate hot path (online per-request evaluation is deferred).
- **SC-010** [US6]: With overlapping rules of distinct priorities on one entitlement, the highest-priority effect wins reproducibly; same-priority conflicts resolve by a deterministic tiebreak.
- **SC-011** [US1]: An admin authoring/editing/enabling a rule is behind the console session + RBAC + CSRF; a viewer cannot author and a missing/mismatched CSRF is refused fail-closed and audited.
- **SC-012** [US2]: An admin, rule, or evaluation from one tenant cannot read, author, or evaluate against another tenant's rules or context; a cross-tenant rule reference resolves to not found; an unset tenant GUC yields zero rows on the policy tables.
- **SC-013** [US3]: No rule expression, decision context, response, log, or audit entry exposes a secret, signing key, or PII beyond a pseudonymous reference.
- **SC-014** [US2]: An already-issued offline license token verifies exactly as before — E017 changes no token bytes and runs no code in the offline verifier core (Principle I).
- **SC-015** [US2]: A rule may raise a numeric limit above the base plan value up to the authored per-entitlement maximum (a contract override); an effect above that maximum is clamped/refused, a boolean the plan does not mark rule-eligible cannot be toggled on, and a select-tier effect resolves only to a plan-defined tier (an undefined tier is refused).
- **SC-017** [US3]: A tenant rule set at the configured per-decision rule cap evaluates within bounds; a rule set that would exceed the per-decision cap fails closed to the base decision (audited), and an authoring action that would push a tenant's live rule set beyond the configured maximum size is rejected — the issuance/signing path stays bounded regardless of rule-set growth.
- **SC-018** [US4]: A dry-run supplied context that is out-of-schema, oversized, or over-depth is rejected before any evaluation under the SAME schema/size/depth bounds as the real assembled context; a within-bounds supplied context evaluates identically to an assembled real context.
- **SC-019** [US1]: Setting or raising a per-entitlement authored maximum (or rule-eligibility / tiers) succeeds only for an admin over a CSRF-protected, audited action and only when the maximum is ≥ the base plan value and within the configured absolute cap; a viewer, or an out-of-range value, is refused.
- **SC-020** [US3]: An audit-write failure during evaluation does not block or crash issuance — the base static decision stands and the token is still issued — while the audit-persistence failure is surfaced to operational logging (never the signing path).
- **SC-021** [US5]: `policy_evaluation` rows older than the configured retention window are removed by the owner-role prune, while rows within the window are retained; the durable rule definitions and their audit within the window are unaffected.

## Stress-Test Findings

### Session 2026-08-11

- **STF-001** (severity: LOW, category: consistency) [RESOLVED inline]: The Q2 resolution (a separately-authored per-entitlement MAXIMUM ≥ the base plan value, letting a rule LIFT above the base) contradicted the pre-clarify "plan ceiling / never exceed what the plan sells" wording scattered across Scope, US2, Key Entities, Risks, and the Glossary. Affected: FR-007, Scope, US2, Key Entities, Risk (over-permissive effect). **Given** a reviewer comparing the Problem Statement's "contract override that lifts a limit" to the old "within the plan's ceiling" wording, **When** they read FR-007, **Then** the bound must consistently be the authored maximum (≥ base), not the base plan value. **Resolution**: replaced all "plan ceiling / plan's ceiling" bound language with the "authored per-entitlement maximum (≥ base plan value)" semantic; also reconciled FR-002 to validate a structured JSON condition (not parse a free-text expression) per Q4.

## Clarifications

### Session 2026-08-11

- Q: MVP evaluation point (FR-008)? → A: Issuance-snapshot ONLY — rules evaluate on the server signing/issuance path (initial issue and re-issuance/renewal) and bake the adjusted snapshot into the signed token; a separate per-request online (E013 validate-time) evaluation surface is DEFERRED. Offline verifier + token format unchanged.
- Q: What bounds an adjust-limit effect (the "authored maximum")? → A: A separately-authored, per-entitlement MAXIMUM (≥ the base plan value) — a rule MAY raise the effective value above the base plan value (contract override) but never above the authored max (FR-007).
- Q: Conflict resolution when multiple rules match one entitlement? → A: Highest-priority-wins — exactly ONE effect applies per entitlement (stable rule-id/version tiebreak); others recorded considered-but-not-applied; no effect chaining (FR-006).
- Q: Rule authoring class? → A: Structured JSON condition (JSONLogic-style / a structured builder UI), NOT a free-text expression editor (FR-001).
- Q: Per-entitlement-type effect semantics? → A: adjust-limit bounded by the authored max; boolean toggle only where the plan marks it rule-eligible (plan defines reachable states); metered select-tier only among plan-defined tiers (FR-003/FR-007). *[applied default]*
- Q: Decision-context field surface + missing-field semantics? → A: an EXPLICIT allow-listed context field schema (the type-check + minimization contract); usage (E016) fields must be `has()`-guarded; an unguarded access to an absent field fails that rule closed, base decision stands (FR-004/FR-010). *[applied default]*
- Q: Are preview/dry-run evaluations audited like enforced? → A: Yes — ONE unified tenant-scoped, RLS-protected, append-only trail, mode-marked (enforced|preview|dry-run), with a nullable/synthetic license reference for supplied-context dry-runs (FR-014). *[applied default]*

## Glossary *(include when spec introduces 2+ domain-specific terms)*

| Term | Definition |
|------|------------|
| Policy rule | A tenant-scoped, versioned `when → then` rule: a guarded condition plus a bounded effect that adjusts an entitlement decision. |
| Guarded condition | A sandboxed, non-Turing-complete STRUCTURED-JSON condition (JSONLogic-style — no arbitrary code, no I/O, no host access) evaluated over a bounded read-only context. |
| Decision context | The bounded, read-only inputs a rule sees: plan/entitlement values (E007), license claims (E008), usage aggregates (E016), and an injected timestamp. |
| Bounded effect | An allow-listed, typed adjustment to an entitlement decision — adjust-limit (clamped to the authored maximum), toggle-boolean (only a plan-marked rule-eligible boolean, to either reachable state), or select-tier (only a plan-defined tier). |
| Authored maximum (ceiling) | A vendor-authored per-entitlement maximum (≥ the base plan value); a rule may raise the effective value above the base plan value up to this maximum but never beyond it. |
| Deterministic evaluation | Same context → same decision; no wall-clock/random/network, stable rule ordering, idempotent re-evaluation. |
| Fail-closed | On any rule error/timeout/bound breach, the base static entitlement decision stands unchanged (the rule is skipped, audited). |
| Preview (report-only) | A rule state that logs its would-be decision without enforcing it, for safe rollout. |
| Dry-run / simulate | Evaluating a rule against a context to see the would-be decision without persisting or enforcing it. |
| Rule version | An immutable snapshot of a rule; an edit creates a new version, prior versions retained for audit/explainability. |

## Compliance Check *(governance audit)*

**Auditor**: PolicyAuditor · **Date**: 2026-08-11 · **Target**: specs/00018-low-code-policy-rules/spec.md
**Governance**: project-instructions.md v1.2.0, AGENTS.md
**Verdict**: PASS-WITH-NOTES — no CRITICAL violation; one Plan-time reconciliation item.

### Non-Negotiables Verified

| Governance rule | Verdict | Evidence |
|-----------------|---------|----------|
| Principle I — Offline-first; signing key never exposed; single crypto core | PASS | FR-008 (control-plane only, not in verifier core, no LIC1 token-format change), FR-018 (no new crypto/signing surface, reuses E004 signer at issuance only), FR-017 (no signing key in context/output), SC-013, SC-014 (already-issued token verifies byte-unchanged); Scope→Excluded and Assumptions restate the boundary. Key risk cleared: engine adjusts pre-sign values via an effect descriptor applied by a trusted applier (FR-003) — no second crypto/code path in the verifier core. |
| Principle II — Multi-tenant isolation + RBAC | PASS | FR-001/FR-016 (console session + RBAC admin/viewer + double-submit CSRF, fail-closed 403), FR-015 (forced RLS; cross-tenant reference → not found), SC-011, SC-012 (unset tenant GUC → zero rows). |
| Principle III — Single security core + append-only audit | PASS | FR-014 (append-only evaluation audit + rule author/edit/enable/disable/version audit, no secrets/PII), FR-018 (policy engine performs no cryptography — no per-language crypto reimplementation). |
| Sandboxing (hard boundary) — no arbitrary code execution | PASS | FR-002 (validate-on-author: parse + type-check + safety-lint + effect-bounds, reject-before-persist), FR-009 (no eval/Function/vm/host/globals/I-O; timeout + size/AST-depth/complexity caps), FR-010 (fail-closed to base static decision, audited). Framed as MUST and Excluded as a "hard security boundary" — not advisory. |
| PII minimization / secret non-exposure | PASS | FR-017 (minimized read-only context; no secret/signing key/PII beyond pseudonymous ref in expression, context, response, log, or audit), SC-013. |
| Deterministic evaluation | PASS | FR-005 (injected decision timestamp only; no wall-clock/random/network/external lookup; idempotent), FR-006 (explicit priority + stable id/version tiebreak), SC-003. |
| Raw-SQL / no-ORM / migration-ordering / src-layout | PASS | MIGRATION signal declares tenant-scoped, forced-RLS, immutable-versioning, append-only tables as a sequential migration after the latest existing (currently 0012_usage_metering → next 0013); no ORM introduced; HOW correctly deferred to Plan. |

### Must-Reconcile at Planning

1. **FR-008 scope**: RESOLVED in Clarify (Session 2026-08-11) — issuance-snapshot ONLY; per-request online (E013) evaluation DEFERRED. Also resolved: authored per-entitlement maximum (contract-override lift, FR-007), highest-priority-wins conflict (FR-006), structured-JSON authoring (FR-001), allow-listed context schema + has()-guards (FR-004), unified mode-marked audit trail (FR-014).
2. **Migration number is illustrative only**: Plan must assign the concrete sequential file (0013…) against the then-latest migration to avoid an ordering collision; the spec intentionally fixes WHAT, not the number.
3. **Guarded-engine selection deferred (NEW-CONFIG / Assumptions)**: Plan must pick the sandboxed, non-Turing-complete evaluator (e.g. CEL / JSONLogic) and prove the FR-009 safety + FR-005 determinism properties; the spec fixes the properties, not the engine — acceptable at spec maturity.

### Flags

None at CRITICAL. Spec is cleared to proceed to Clarify/Plan; item 1 above is the Clarify target.
