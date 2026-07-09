# Data Integrity Checklist: License Issuance and Lifecycle
**Created**: 2026-07-08 | **Feature**: [spec.md](../spec.md)
**Domain**: Data Integrity | **Depth**: Standard | **Audience**: Reviewer (PR)

## Snapshot Semantics

- [X] CHK001 Are the attributes copied into the license snapshot at issue time fully enumerated, with their value shapes specified (entitlements jsonb map + max_activations int)? [Completeness, FR-002/data-model §3, §5] <!-- Evaluator: Covered by data-model §3 (entitlements jsonb `{key:bool|number}`, max_activations int CHECK>0) + §5 -->
- [X] CHK002 Is it stated unambiguously that product_id/plan_id FKs are provenance-only and not a live join used to re-derive entitlements or seat limit? [Clarity, data-model §3, §5] <!-- Evaluator: Covered by data-model §3 (plan_id note: "FK records provenance only") + §5 ("provenance, not a live join... never re-derived from the catalog") -->
- [X] CHK003 Is the invariant "catalog edits after issuance never mutate an issued license" expressed consistently across spec and data-model? [Consistency, FR-006/data-model §5] <!-- Evaluator: Covered by data-model §5 (cites FR-006/SC-003) consistent with spec FR-006 + SC-003 -->
- [X] CHK004 Is the snapshot source (E007 effective-plan read model) and its timing (copied at issue) specified? [Completeness, data-model §5, §9] <!-- Evaluator: Covered by data-model §5 ("reads E007's effective-plan read model... copies it at issue time") + §9 -->
- [X] CHK005 Is the split between what is stored in the row vs. what is signed into the token specified so the two definitions cannot silently drift? [Consistency, data-model §4] <!-- Evaluator: Covered by data-model §4 (signed-vs-row table; token is a signed projection derived from the row's snapshot → cannot drift) -->
- [X] CHK006 Is reissue's effect on the snapshot specified (id/terms/snapshot unchanged; only license_token + key_id rewritten)? [Completeness, FR-018/data-model §5, §7] <!-- Evaluator: Covered by data-model §5 ("rewrites license_token + key_id but leaves the snapshot, id, and terms untouched") + §7 reissue row -->

## Referential Integrity & Composite FKs

- [X] CHK007 Are all three license FKs (product, plan, customer) specified as composite `(tenant_id, x)` FKs binding to a tenant-local parent key? [Completeness, data-model §3, §8] <!-- Evaluator: Covered by data-model §3 + §8 (all three composite FKs → product/plan/customer (tenant_id, id)) -->
- [X] CHK008 Is "a license/customer can never bind cross-tenant" stated as a data-level invariant (composite FK + PK) rather than only app logic? [Clarity, FR-015/data-model §1] <!-- Evaluator: Covered by data-model §1 Conventions (composite PK (tenant_id, id) + tenant_id-bearing FKs: "a child can never bind to another tenant's parent") -->
- [X] CHK009 Is the composite primary key `(tenant_id, id)` defined consistently on both new tables? [Consistency, data-model §8] <!-- Evaluator: Covered by data-model §8 (PK both), consistent with §2/§3/§11 DDL (PRIMARY KEY (tenant_id, id) on customer and license) -->
- [X] CHK010 Is the ON DELETE behavior specified for each FK (NO ACTION on the customer FK as the erasure backstop)? [Completeness, data-model §6, §8] <!-- Evaluator: Resolved — customer FK already had explicit ON DELETE NO ACTION (§6/§8); made ON DELETE NO ACTION explicit for the product & plan FKs too (data-model §8 table + §11 DDL comment) so all three FKs' delete behavior is stated -->
- [X] CHK011 Are the referenced parent tables and their target keys identified so the FK targets are unambiguous? [Clarity, data-model §9] <!-- Evaluator: Covered by data-model §3/§8/§11 (targets product/plan/customer (tenant_id, id); tenant(id)) + §9 integration boundaries identifying the E007/E002 parents -->

## Lifecycle State Machine

- [X] CHK012 Are the status domains fully enumerated with their defaults (license active/suspended/revoked default active; customer active/anonymized default active)? [Completeness, FR-007/data-model §3, §8] <!-- Evaluator: Covered by data-model §3 (DEFAULT 'active' + CHECK IN(...) on both) + §8 status enums -->
- [X] CHK013 Are all valid transitions enumerated with explicit source and target states? [Completeness, FR-007/008/010/data-model §7] <!-- Evaluator: Covered by data-model §7 state-machine table (From/Action/To for issue/suspend/reinstate/revoke/transfer/reissue) -->
- [X] CHK014 Is a guard/precondition specified for each transition (issue prerequisites, transfer limit, transfer target differs)? [Completeness, data-model §7] <!-- Evaluator: Covered by data-model §7 Guard column (issue prereqs; transfer_count < transfer_limit; new customer_id ≠ current) -->
- [X] CHK015 Is revoke specified as both terminal and idempotent, with the repeat-revoke case defined as a no-op rather than an error? [Clarity, FR-007/data-model §7] <!-- Evaluator: Covered by data-model §7 (revoked terminal; revoked→revoke = "idempotent no-op (not an error)", US2-AC3) + §1 -->
- [X] CHK016 Is the handling of every invalid transition specified (refused with a clear reason, license left unchanged)? [Completeness, FR-010/SC-008/data-model §7] <!-- Evaluator: Covered by data-model §7 ("Any transition not in this table is refused with a clear, specific reason and leaves the license unchanged (FR-010, SC-008)" + Refused examples) -->
- [X] CHK017 Is reinstate's precondition (permitted only from suspended) specified unambiguously? [Clarity, FR-008/data-model §7] <!-- Evaluator: Covered by data-model §7 (only suspended→reinstate→active; Refused example: "reinstate a license that is not suspended") -->
- [X] CHK018 Is it specified which fields are immutable across lifecycle actions (id, issued_at, snapshot) vs. mutable (status, customer_id, transfer_count, key_id/token, updated_at)? [Consistency, data-model §3, §4] <!-- Evaluator: Covered by data-model §3 (id "stable", issued_at "unchanged by lifecycle", entitlements/max_activations immutable snapshot; customer_id changes on transfer, transfer_count incremented, key_id/token change on reissue, updated_at bumped) + §4 row-only set -->

## Transfer Bounds

- [X] CHK019 Is the transfer_count lower bound specified as a DB CHECK (`>= 0`)? [Completeness, FR-009/data-model §8] <!-- Evaluator: Covered by data-model §8 (transfer floor CHECK (transfer_count >= 0)) + §3 + §11 DDL -->
- [X] CHK020 Is the upper bound defined as an app-config transfer limit with a configurable default, with the rationale for it not being a DB CHECK stated? [Clarity, FR-009/data-model §7] <!-- Evaluator: Covered by data-model §7 ("transfer_limit is app-config, not a column... deliberately not a table CHECK because the limit is a runtime/config value") + §3; configurable default per FR-009 (plan AD-006 default 3) -->
- [X] CHK021 Is the transfer mutation semantics specified (default 0 at issue, increment by 1, reassign customer_id, new customer differs from current)? [Completeness, FR-009/data-model §3, §7] <!-- Evaluator: Covered by data-model §3 (transfer_count DEFAULT 0, incremented; customer_id changes on transfer) + §7 ("new customer_id ≠ current; sets customer_id, transfer_count += 1") -->

## Tenant Isolation (RLS)

- [X] CHK022 Is forced RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY`) required on both new tables? [Completeness, FR-015/data-model §10] <!-- Evaluator: Covered by data-model §10 (ENABLE + FORCE ROW LEVEL SECURITY on customer and license) + §11 DDL -->
- [X] CHK023 Is the tenant_isolation policy predicate specified for both USING (read) and WITH CHECK (write)? [Completeness, data-model §10] <!-- Evaluator: Covered by data-model §10 (predicate on both USING and WITH CHECK: tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid) -->
- [X] CHK024 Is the unset-GUC behavior specified (NULL tenant → zero rows → unscoped access refused, not run unscoped)? [Clarity, FR-015/SC-009/data-model §10] <!-- Evaluator: Covered by data-model §10 ("NULL when the GUC is unset → predicate matches zero rows, so an unscoped query is refused, never run unscoped (FR-015, SC-009)") -->
- [X] CHK025 Are the grants to `licensesrv_app` enumerated, and is the non-owner NOBYPASSRLS role requirement stated? [Completeness, data-model §10] <!-- Evaluator: Covered by data-model §10 (GRANT SELECT,INSERT,UPDATE,DELETE ON customer, license TO licensesrv_app; FORCE subjects owner too) + §1 ("non-owner, NOBYPASSRLS role licensesrv_app") -->
- [X] CHK026 Is it specified that all indexes are tenant_id-leading to match the RLS predicate? [Consistency, data-model §8] <!-- Evaluator: Covered by data-model §8 ("All indexes are tenant_id-leading, matching the RLS predicate...") consistent with §11 DDL -->

## Customer Erasure (GDPR)

- [X] CHK027 Are the two erasure paths specified with an unambiguous selection criterion (anonymize when the customer holds licenses vs. hard-delete when license-free), including the "holds licenses?" probe? [Clarity, FR-019/data-model §6] <!-- Evaluator: Covered by data-model §6 (hard-delete when license-free vs anonymize when licenses exist; probe = "any license (tenant_id, customer_id) exists", served by license_customer index) -->
- [X] CHK028 Is the anonymize action fully specified (null name + email, status = anonymized, ref retained, one-way active → anonymized)? [Completeness, FR-019/data-model §6] <!-- Evaluator: Covered by data-model §6 ("null name + email, set status = 'anonymized', bump updated_at; the row and its ref stay"; "Anonymization is one-way: active → anonymized only") -->
- [X] CHK029 Is the `ON DELETE NO ACTION` FK backstop specified as the DB safety net against hard-deleting a referenced customer? [Completeness, data-model §6, §8] <!-- Evaluator: Covered by data-model §6 (license_customer_fk NO ACTION "Postgres rejects deleting a customer that any license references") + §8 -->
- [X] CHK030 Is the rationale for rejecting `ON DELETE CASCADE` captured (avoid silently destroying issued licenses and their history)? [Clarity, data-model §6] <!-- Evaluator: Covered by data-model §6 ("Why not ON DELETE CASCADE? Cascading would silently destroy issued licenses (and their audit-relevant history)... unacceptable") -->

## Term, Uniqueness & Identity

- [X] CHK031 Is the perpetual vs. time-limited term encoded unambiguously (expires_at NULL = perpetual; non-null = time-limited)? [Clarity, FR-001/data-model §3] <!-- Evaluator: Covered by data-model §3 (expires_at: "NULL = perpetual; a non-null value = time-limited term") + §11 DDL -->
- [X] CHK032 Is customer reference uniqueness scoped per tenant (`UNIQUE (tenant_id, ref)`) and specified? [Completeness, FR-011/data-model §8] <!-- Evaluator: Covered by data-model §8 (customer ref uniqueness UNIQUE (tenant_id, ref)) + §2/§3/§11 -->
- [X] CHK033 Is the license id specified as unique, stable across suspend/reinstate/transfer/reissue, and the identity embedded in the token? [Consistency, FR-002/data-model §3] <!-- Evaluator: Covered by data-model §3 (id: "unique license id (FR-002) embedded in the token. Stable across suspend/reinstate/transfer/reissue") consistent with §4 signed claims -->

## Token & Crypto-Provenance Storage

- [X] CHK034 Are the storage requirements and nullability specified for key_id, token_version, nonce, and license_token? [Completeness, data-model §3] <!-- Evaluator: Covered by data-model §3 (key_id text nullable; token_version int NOT NULL; nonce text NOT NULL; license_token text NOT NULL) + §11 DDL -->
- [X] CHK035 Is it stated consistently that only the public token/key_id is stored and the private signing key is never stored, logged, or returned? [Consistency, FR-003/SC-010/data-model §3, §9] <!-- Evaluator: Covered by data-model §3 (key_id: "signing key material itself is never stored here (SC-010)"; license_token: "only public claims + signature, never the private key") + §9 ("private key is never stored, logged, or returned") -->
- [X] CHK036 Is key_id's lifecycle specified (transiently null before first sign, stamped by the signer, changes on reissue)? [Clarity, FR-003/FR-018/data-model §3] <!-- Evaluator: Covered by data-model §3 ("Null only transiently before the first successful sign; changes on reissue after key rotation") + §9 (signer "stamps the key_id used") -->
- [X] CHK037 Is the nonce's purpose (per-license issuance distinctness) and its requiredness specified? [Clarity, data-model §3] <!-- Evaluator: Covered by data-model §3 (nonce text NOT NULL; "Per-license nonce mixed into the token for issuance distinctness (two licenses over identical terms produce distinct tokens)") -->

## Migration Safety

- [X] CHK038 Is the migration specified as expand-only and sequential after 0006 (`0007_licensing.sql`)? [Completeness, data-model §11/plan Data Model Summary] <!-- Evaluator: Covered by data-model header + §11/§13 ("migrations/0007_licensing.sql (expand-only, sequential after 0006)") + plan Data Model Summary -->
- [X] CHK039 Is it stated that the migration is purely additive with no changes to existing tables? [Consistency, data-model §5-preamble, §11] <!-- Evaluator: Covered by data-model header ("two additive tables... No changes to existing tables") + §11 DDL comment ("No changes to existing tables") + §13 -->
- [X] CHK040 Are the timestamp conventions specified for both tables (created_at/updated_at defaults; updated_at bumped on every edit, including lifecycle actions and anonymization)? [Completeness, data-model §2, §3] <!-- Evaluator: Covered by data-model §1 Timestamps convention + §2 (customer updated_at "Bumped... every edit (incl. anonymization)") + §3 (license updated_at "Bumped on every lifecycle action") -->
