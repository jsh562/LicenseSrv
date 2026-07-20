# Data Integrity Checklist: Billing-driven Entitlement Automation
**Created**: 2026-07-19 | **Feature**: [spec.md](../spec.md)

## Additive Expand-Only Migration & E008 Boundary

- [X] CHK001 Is the "expand-only, additive" nature of `0010_billing.sql` bounded precisely enough (only CREATE TABLE/INDEX/VIEW/policy/grant; no ALTER or DROP on any existing object) for a reviewer to confirm no existing table or column is touched? [Completeness, data-model §0/§14 / plan MIGRATION] <!-- Evaluator: Covered by data-model.md §0 header + §14 DDL comment ("No changes to any existing table or column"; ALTERs only on the new tables) -->

- [X] CHK002 Is the invariant that the E008 `license.status` enum (active/suspended/revoked) stays UNCHANGED stated as a hard, non-reversible constraint and traceable to the decision that rejected adding a `grace` status? [Traceability, ADR-0011 §Option C / data-model §5] <!-- Evaluator: Covered by data-model.md §5/§9 ("adds no enum value") + ADR-0011 Option C (rejected `grace` status) -->

- [X] CHK003 Is the migration's ordering and re-application posture (sequential after `0009`, applied under the expand/contract advisory-locked harness) specified clearly enough to judge safe forward-only application? [Clarity, plan §Project Structure / data-model §7 header] <!-- Evaluator: Covered by data-model.md header ("expand-only, sequential after 0009") + plan.md §Project Structure Patterns to reuse (advisory-locked expand/contract harness) -->


## Tenant Isolation, Forced RLS & Composite FKs

- [X] CHK004 Is `ENABLE` + `FORCE ROW LEVEL SECURITY` required explicitly for each of the three new tables (billing_connection / subscription / billing_event), not asserted generically? [Completeness, data-model §10/§13] <!-- Evaluator: Covered by data-model.md §10/§14 (explicit ENABLE+FORCE per table) + §13 -->

- [X] CHK005 Is the `tenant_isolation` policy predicate specified for BOTH read (`USING`) and write (`WITH CHECK`), including the fail-closed unset-GUC → zero-rows behaviour (never an unscoped scan)? [Completeness, data-model §10/§13 / FR-014] <!-- Evaluator: Covered by data-model.md §10 (USING + WITH CHECK predicate; unset GUC → NULL → zero rows) + §14 DDL -->

- [X] CHK006 Is the requirement that every cross-table reference be a `tenant_id`-leading COMPOSITE FK stated unambiguously enough that "a child can never bind another tenant's parent" is checkable? [Clarity, data-model §12/§13 / FR-014] <!-- Evaluator: Covered by data-model.md §Conventions + §12 (every FK composite tenant-leading) + §13 (child can never bind another tenant's parent) -->

- [X] CHK007 Does FR-014's prose "tenant-scoped" guarantee map concretely onto the data-layer mechanisms (forced RLS + composite FK + tenant-resolved connection), rather than remaining an untethered assertion? [Traceability, FR-014 / data-model §13] <!-- Evaluator: Covered by data-model.md §13 (FR-014 mapped to forced RLS + composite FKs + secret-excluding view + per-tenant workers) -->


## Idempotency & Dedup Integrity

- [X] CHK008 Is the idempotency key specified as exactly `UNIQUE(tenant_id, provider, provider_event_id)`, with the inclusion of `provider` justified so two providers cannot alias on the same event id? [Completeness, data-model §7/§12 / FR-003] <!-- Evaluator: Covered by data-model.md §7 (provider in key so two providers can't alias) + §12 idempotency key -->

- [X] CHK009 Is the distinction between "a duplicate is NEVER stored as a second ledger row" and "duplicate is an ack/response value" made unambiguous, so the stored `outcome` domain and the webhook-ack `outcome` domain cannot be conflated? [Ambiguity, data-model §7 / OpenAPI EventOutcome vs AckOutcome] <!-- Evaluator: Covered by data-model.md §7 ("duplicate is API/response vocabulary, never a stored row") + contracts EventOutcome{applied,deadletter,rejected} vs AckOutcome{applied,duplicate,deadletter} -->

- [X] CHK010 Is the requirement that the ledger row be INSERTed in the SAME transaction as its side effect (`ON CONFLICT DO NOTHING`) stated as a data-integrity invariant, so at-least-once redelivery applies at most once? [Completeness, FR-003 / data-model §7] <!-- Evaluator: Covered by data-model.md §7 + §11 invariant 1 (INSERT … ON CONFLICT DO NOTHING same-tx as side effect) + spec FR-003 -->

- [X] CHK011 Is the dedup-record retention horizon required to exceed the provider retry window (≥48h) specified, so pruning cannot reintroduce a duplicate-apply? [Measurability, data-model §8 / research §idempotency] <!-- Evaluator: Covered by data-model.md §8 (horizon exceeds provider retry window, ≥48h) + spec FR-021 (retention FLOOR above the idempotency/anti-replay floor, ≥48h) -->


## Subscription ↔ License Linkage (1:1)

- [X] CHK012 Is the subscription↔license cardinality specified as strictly 1:1 via `UNIQUE(tenant_id, license_id)`, so one subscription cannot drive two licenses and one license cannot be driven by two subscriptions? [Completeness, data-model §3/§12 / FR-012] <!-- Evaluator: Covered by data-model.md §3 + §12 (UNIQUE(tenant_id, license_id) = at most one subscription per license; single license_id column = one license per subscription) -->

- [X] CHK013 Is the resolve key `UNIQUE(tenant_id, provider, external_subscription_id)` specified so every incoming event resolves to exactly one subscription? [Completeness, data-model §3/§12 / FR-012] <!-- Evaluator: Covered by data-model.md §3 (resolve key maps an event to exactly one row) + §12 subscription resolve key -->

- [X] CHK014 Is the `license_id` FK's behaviour (intra-tenant composite, `ON DELETE NO ACTION`) specified so the 1:1 link can be neither orphaned nor cross-tenant? [Consistency, data-model §12 / FR-012] <!-- Evaluator: Covered by data-model.md §3 + §12 + §14 (composite (tenant_id, license_id) FK, ON DELETE NO ACTION, intra-tenant) -->

- [X] CHK015 Is it specified whether `license_id` is set once at provisioning and whether it is nullable/immutable, removing ambiguity about ever re-linking a subscription to a different license? [Ambiguity, data-model §3 / FR-005/012] <!-- Evaluator: Resolved — added "set ONCE at provisioning, IMMUTABLE thereafter, never re-pointed" to data-model.md §3 (license_id) + §11 invariant 9 (1:1 link immutability) -->


## Billing-State Overlay & `license.status` Consistency

- [X] CHK016 Is the `billing_state` domain enumerated exhaustively (active/past_due/grace/canceled/refunded) with each value's driven `license.status` mapping specified without gaps? [Completeness, data-model §5/§6] <!-- Evaluator: Covered by data-model.md §5 (all five states → license.status mapping table) + §6 -->

- [X] CHK017 Is every allowed `billing_state` transition and its trigger specified, and are disallowed transitions explicitly closed so `refunded` cannot transition onward? [Coverage, data-model §6 / FR-010] <!-- Evaluator: Covered by data-model.md §6 (transition table with triggers; refunded → refunded terminal, never resurrected) + spec FR-010 -->

- [X] CHK018 Is the overlay→`license.status` mapping internally consistent (past_due/grace ⇒ license active; canceled ⇒ suspended; refunded ⇒ revoked) with no contradiction between the §5 table and the §6 state machine? [Consistency, data-model §5/§6] <!-- Evaluator: Covered by data-model.md §5 (mapping table) and §6 (state machine License-action column) — consistent (past_due/grace→active, canceled→suspend, refunded→revoke) -->

- [X] CHK019 Is the "revoked is terminal, never resurrected" invariant stated for BOTH the billing overlay (`refunded` terminal) and the E008 license, so a later event cannot drive a revoked license back to active? [Consistency, FR-010 / data-model §6] <!-- Evaluator: Covered by data-model.md §6 (refunded terminal) + §5/§9 (license revoked terminal) + spec FR-010 (revoked MUST NOT be resurrected by any later event) -->

- [X] CHK020 Is it specified that E014 DRIVES `license.status` only through the E008 lifecycle services (never a direct write to license columns/enum), so no second write path to `license.status` is introduced? [Clarity, data-model §9 / ADR-0011] <!-- Evaluator: Covered by data-model.md §9 ("drives via the existing E008 services; adds no column/enum value") + §11 invariant 3 + ADR-0011 Decision Outcome 3/6 -->


## Grace & Recency-Guard Integrity

- [X] CHK021 Is `grace_expires_at`'s meaning and lifecycle specified (set only in past_due/grace, cleared on recovery/suspend) including the CHECK that it is NULL outside a grace window? [Completeness, data-model §3/§12 / FR-007/008] <!-- Evaluator: Covered by data-model.md §3 (set in past_due/grace, cleared on recovery/suspend) + §12 grace shape CHECK (billing_state IN (past_due,grace) OR grace_expires_at IS NULL) -->

- [X] CHK022 Is `last_applied_event_at` required to be monotonic non-decreasing, advanced only by a guarded repository UPDATE (not a DB trigger), with the stale comparison (`occurred_at <= last_applied_event_at` ⇒ ignore) unambiguously defined? [Ambiguity, data-model §3/§11 / FR-016] <!-- Evaluator: Covered by data-model.md §3 (monotonic non-decreasing, guarded repo UPDATE not a trigger, occurred_at <= last_applied_event_at ignored) + §11 invariant 2 -->

- [X] CHK023 Is it specified what a reconciliation snapshot contributes to `last_applied_event_at`, so the webhook and reconciliation paths share one recency-guard semantics? [Coverage, data-model §3 / FR-016/017] <!-- Evaluator: Covered by data-model.md §3 ("occurred_at of the last applied event OR reconciliation snapshot ts") + contracts /admin/billing/reconcile ("corrections apply the same recency guard, FR-016") -->

- [X] CHK024 Is the time-driven auto-suspend requirement (suspend when `grace_expires_at <= now()` even absent any further webhook) stated as a data/behavioural invariant rather than left implicit to the worker? [Completeness, FR-008 / data-model §11] <!-- Evaluator: Covered by data-model.md §11 invariant 4 (suspend when grace_expires_at <= now() even absent a webhook) + §6 (time-driven, not webhook-driven) + spec FR-008 -->

- [X] CHK025 Are the `default_grace_seconds` bounds specified (`> 0`, sane ~14d default, per-plan overrides) so a grace window can never be zero or negative? [Measurability, data-model §2/§12 / FR-011] <!-- Evaluator: Resolved — data-model.md §2/§12 already bound default_grace_seconds (CHECK > 0, default 1209600 ~14d); added the grace_overrides positivity invariant (each override app-validated > 0, matching API minimum:1) to §2 so no effective grace window is ever zero/negative -->


## Append-Only Ledger & Outcome Domain

- [X] CHK026 Is the append-only posture of `billing_event` specified as a `GRANT SELECT, INSERT`-only requirement (no UPDATE/DELETE for the app role) so ledger rows are immutable to the application? [Completeness, data-model §8/§10 / FR-013] <!-- Evaluator: Covered by data-model.md §10/§14 (GRANT SELECT, INSERT ON billing_event only) + §8 + §Conventions (append-only ledger) -->

- [X] CHK027 Is the STORED `outcome` domain enumerated as exactly {applied, deadletter, rejected} with `duplicate` explicitly excluded, so the CHECK constraint and the ack vocabulary do not conflict? [Consistency, data-model §7/§12 / OpenAPI EventOutcome] <!-- Evaluator: Covered by data-model.md §1/§7/§12/§14 (outcome CHECK IN (applied,deadletter,rejected); duplicate never stored) + contracts EventOutcome enum -->

- [X] CHK028 Is the outcome↔reason coupling specified (applied ⇒ reason null; non-applied ⇒ reason present) so a stored row cannot be in an inconsistent applied-with-reason or deadletter-without-reason state? [Completeness, data-model §12] <!-- Evaluator: Covered by data-model.md §12 + §14 (CHECK (outcome='applied' AND reason IS NULL) OR (outcome<>'applied' AND reason IS NOT NULL)) -->

- [X] CHK029 Is the ledger's population boundary unambiguous — a signature/timestamp/schema failure produces NO ledger row (rejected inline) while a post-verification reject/dead-letter DOES produce one? [Ambiguity, data-model §7 / FR-002/020] <!-- Evaluator: Covered by data-model.md §7 ("signature/timestamp failure rejected inline with NO ledger row; the ledger only holds post-verification events") + §11 invariant 1 + spec FR-002/020 -->

- [X] CHK030 Is the unmapped dead-letter case specified (`subscription_id` nullable, MATCH SIMPLE skips the FK when null) so an unmapped event can be recorded without a resolvable subscription? [Coverage, data-model §12 / FR-020] <!-- Evaluator: Covered by data-model.md §12 (event→subscription FK nullable, MATCH SIMPLE skips when NULL) + §1 + §14 DDL (unmapped → dead-letter) -->


## Webhook Signing-Secret Custody

- [X] CHK031 Is it specified that the signing secret is stored ONLY as an encrypted/custody-wrapped ref (`signing_secret_ref`/`signing_secret_prev`), never as plaintext at rest, in logs, or in diagnostics? [Completeness, data-model §4/§11 / FR-015] <!-- Evaluator: Covered by data-model.md §4 (no column holds the secret in plaintext, never logged) + §11 invariant 6 + spec FR-022 -->

- [X] CHK032 Is the "secret never returned by any API" invariant specified via the secret-excluding projection (`billing_connection_public` omits BOTH secret columns), so no response or view path can leak it? [Completeness, data-model §4/§10 / FR-015/SC-007] <!-- Evaluator: Covered by data-model.md §4 point 1 + §10 (billing_connection_public view omits signing_secret_ref AND signing_secret_prev) + spec FR-022/SC-007 -->

- [X] CHK033 Is the rotation model specified precisely enough (two secrets + `secret_rotated_at` bounding a transition window during which both verify, and when `signing_secret_prev` is nulled) to remove ambiguity about which secret is valid when? [Ambiguity, data-model §4 / US5-AC2] <!-- Evaluator: Covered by data-model.md §4 Rotation (writes new to ref, moves old to prev, stamps secret_rotated_at; both accepted while now()-secret_rotated_at < window default 24h; prev nulled when window closes) + spec FR-022 -->

- [X] CHK034 Is the distinction between this inbound-HMAC secret class and the E004 Ed25519 signing key — and the justified LOWER custody tier (must be readable to recompute the HMAC) — documented so the "no new key custody" invariant is traceable? [Traceability, data-model §4 / ADR-0011] <!-- Evaluator: Covered by data-model.md §4 ("Why a lower custody tier … the HMAC secret must be readable server-side to recompute the HMAC") + §8/§9 (no new key custody) + ADR-0011 Driver/Outcome 5 -->


## Data Minimization, No Card Data & GDPR

- [X] CHK035 Is the "no card/PAN/CVV/expiry" rule on `payload_summary` stated as an app-layer allow-list invariant (acknowledging a single-table CHECK cannot prove absence of PAN) rather than merely assumed? [Clarity, data-model §8/§11 / FR-018] <!-- Evaluator: Covered by data-model.md §8 ("a CHECK can't prove no PAN, so the allow-list is an app-layer invariant") + §11 invariant 7 (closed deny-by-default allow-list) + spec FR-018 -->

- [X] CHK036 Is it specified that the RAW provider payload is NEVER persisted (only a minimized, allow-listed `payload_summary`), so the ledger cannot accumulate PII or financial fields? [Completeness, data-model §8 / FR-018/021] <!-- Evaluator: Covered by data-model.md §8 ("No raw payload persisted"; "Why not the raw payload") + §11 invariant 7 + contracts WebhookEnvelope ("never the raw payload") -->

- [X] CHK037 Is the retention-bounded + deletable requirement expressed with a concrete horizon relation (age-based prune on `received_at`, horizon exceeding the provider retry window) so FR-021 is measurable? [Measurability, data-model §8 / FR-021] <!-- Evaluator: Covered by data-model.md §8 (age-based prune on received_at, BRIN, horizon exceeds retry window ≥48h) + §12 billing_event_prune + spec FR-021 (default 365d, measurable upper bound) -->

- [X] CHK038 Is it specified that subscription/billing rows carry no independent PII (only pseudonymous ids + the license link) and that GDPR erasure flows through the E008 `customer`, so the new tables inherit the erasure guarantee? [Traceability, data-model §8 / FR-021] <!-- Evaluator: Covered by data-model.md §8 ("subscription holds no PII … a GDPR erasure of a customer flows through E008; the billing rows carry no independent PII") + spec FR-021 -->

