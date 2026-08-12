-- E017 low-code policy rules (FR-001..FR-018). Extends the E002 tenancy substrate and the E007 catalog
-- `entitlement` (expand-only, sequential after 0012_usage_metering.sql). Two new tenant-owned tables:
-- policy_rule (immutably versioned, guarded structured-JSON condition + bounded typed effect) and
-- policy_evaluation (ONE unified, mode-marked, append-only decision audit). Same tenant-scoped forced-RLS +
-- composite-FK + append-only-ledger pattern as 0006/0007/0008/0009/0010/0011/0012. NO change to any EXISTING
-- column: the E007 boolean/integer_limit + E016 metered entitlement semantics and their plan_entitlement value
-- columns are UNTOUCHED -- the rule_max/rule_eligible/rule_tiers columns are ADDITIVE authored-bound attributes.
--
-- No new crypto / no signing surface (FR-018, SC-014): the policy engine performs no cryptography and does not
-- touch the E004 signer or the E001 verifier core; issuance keeps signing the (possibly rule-adjusted) snapshot
-- with the existing signer. Nothing here stores a secret, signing key, or PII -- the condition, effect,
-- input_snapshot, and decision are minimized, allow-listed, pseudonymous (FR-017, SC-013).
--
-- Immutable versioning (AD-006, FR-011, HINT-004): a logical rule (rule_key) is a set of IMMUTABLE version
-- rows; a content edit INSERTs a NEW (rule_key, version) row and never mutates a prior version. STATUS is the
-- ONLY mutable field -- enable/disable/preview flips status in place (a lifecycle toggle, not a content edit),
-- so the app role gets UPDATE (repo-restricted to status/updated_at). policy_rule_one_live guarantees at most
-- one live (active|preview) version per rule_key -> "the current version" is unambiguous for evaluation.
--
-- Highest-priority-wins (AD-005, FR-006): exactly ONE matching rule's effect applies per entitlement; the
-- (tenant_id, entitlement_id, status, priority DESC) lookup index drives the deterministic priority scan with a
-- stable (rule_key, version) tiebreak. Others are recorded considered-but-not-applied in the audit.
--
-- Effect bounds (AD-002/003, FR-007, HINT-003): the DB constrains effect SHAPE (kind in the allow-list); the
-- "<= authored rule_max / rule_eligible boolean / plan-defined tier" BOUND is enforced by the trusted applier at
-- author validation AND evaluation -- a single-table CHECK cannot join entitlement/plan_entitlement (the base
-- plan value lives on plan_entitlement.int_value). rule_max must be >= the base plan value: a service-layer check.
--
-- Append-only audit (AD-008, FR-014): policy_evaluation is a unified mode-marked (enforced|preview|dry_run)
-- trail; SELECT,INSERT only (no app UPDATE/DELETE). license_id is NULLABLE for a supplied-context synthetic
-- dry-run; BRIN(created_at) backs the age-based retention prune (owner-role, like usage_event/billing_event).

-- =====================================================================================================
-- 1. entitlement (E007) -- expand-only authored per-entitlement rule bound. Existing rows unchanged.
-- =====================================================================================================
-- The authored MAXIMUM (>= base plan value) an adjust_limit effect clamps to (FR-007), toggle-boolean
-- eligibility (the plan defines reachable states, FR-003), and the plan-defined select_tier options. Existing
-- boolean/integer_limit/metered rows carry rule_eligible=false (safe: not rule-eligible) and NULL bounds.
ALTER TABLE entitlement
  ADD COLUMN rule_max      numeric,                          -- authored max for adjust_limit; NULL = no rule-raise (>= base: service-layer, HINT-003)
  ADD COLUMN rule_eligible boolean NOT NULL DEFAULT false,   -- may a toggle_boolean effect flip this boolean entitlement? (FR-003/007)
  ADD COLUMN rule_tiers    jsonb;                            -- plan-defined select_tier options; NULL = no tiers

ALTER TABLE entitlement
  ADD CONSTRAINT entitlement_rule_max_nonneg
    CHECK (rule_max IS NULL OR rule_max >= 0),
  ADD CONSTRAINT entitlement_rule_tiers_array
    CHECK (rule_tiers IS NULL OR jsonb_typeof(rule_tiers) = 'array');
-- NOTE (FR-007, service-layer): rule_max MUST be >= the base plan value for that entitlement (a contract
-- override lifts ABOVE base, never above rule_max). The base value lives on plan_entitlement.int_value; a DB
-- CHECK cannot join it, so the author-validation + evaluation applier enforce the ">= base" bound. Not in DDL.

-- =====================================================================================================
-- 2. policy_rule -- tenant-scoped, immutably versioned guarded rule (condition + bounded typed effect).
-- =====================================================================================================
CREATE TABLE policy_rule (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL REFERENCES tenant(id),
  rule_key       text        NOT NULL,                       -- LOGICAL rule id; stable across versions (FR-011)
  version        int         NOT NULL CHECK (version >= 1),  -- immutable version; a content edit INSERTs version+1
  entitlement_id uuid        NOT NULL,                       -- TARGET entitlement (composite FK below); its key embeds into the token
  plan_id        uuid,                                       -- OPTIONAL plan scope; NULL = any plan granting the entitlement (composite FK below)
  condition      jsonb       NOT NULL,                       -- guarded structured-JSON (JSONLogic-subset) condition; allow-list validated at author time (FR-001/002)
  effect         jsonb       NOT NULL,                       -- closed typed descriptor {kind,target,value}; bounds applied by the trusted applier (AD-002, FR-003/007)
  priority       int         NOT NULL DEFAULT 0,             -- explicit order; highest-priority-wins (AD-005, FR-006)
  status         text        NOT NULL DEFAULT 'preview'      -- MUTABLE lifecycle: preview (report-only) | active (enforced) | disabled (never evaluates)
                   CHECK (status IN ('active','preview','disabled')),
  author         text        NOT NULL,                       -- authoring admin principal (pseudonymous ref, no PII)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),         -- bumped only on a status transition (content is immutable)
  PRIMARY KEY (tenant_id, id),
  -- Immutable versioning key: at most one row per (tenant, logical rule, version); a content edit = version+1.
  CONSTRAINT policy_rule_version_uniq UNIQUE (tenant_id, rule_key, version),
  -- effect SHAPE: closed allow-listed kind (the <= max / rule-eligible / plan-tier BOUND is service-layer).
  CONSTRAINT policy_rule_effect_kind CHECK (
    jsonb_typeof(effect) = 'object'
    AND effect ? 'kind'
    AND effect->>'kind' IN ('adjust_limit','toggle_boolean','select_tier')),
  -- condition MUST be a structured-JSON object (a free-text expression is refused at author time, FR-001/002).
  CONSTRAINT policy_rule_condition_object CHECK (jsonb_typeof(condition) = 'object'),
  -- intra-tenant composite FK: a rule can never target another tenant's entitlement (FR-015). ON DELETE NO
  -- ACTION: an entitlement referenced by any rule version cannot be hard-deleted (codebase uniformity).
  CONSTRAINT policy_rule_entitlement_fk
    FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlement (tenant_id, id) ON DELETE NO ACTION,
  -- intra-tenant composite FK: an optional plan scope can never be another tenant's plan (NULL = unscoped).
  CONSTRAINT policy_rule_plan_fk
    FOREIGN KEY (tenant_id, plan_id)        REFERENCES plan        (tenant_id, id) ON DELETE NO ACTION
);

-- =====================================================================================================
-- 3. policy_evaluation -- tenant-scoped, unified mode-marked, APPEND-ONLY decision audit.
-- =====================================================================================================
CREATE TABLE policy_evaluation (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL REFERENCES tenant(id),
  license_id      uuid,                                      -- NULLABLE: a supplied-context synthetic dry-run has none (composite FK below)
  plan_id         uuid,                                      -- decided plan; NULL for a supplied/synthetic dry-run (composite FK below)
  entitlement_key text        NOT NULL,                      -- the entitlement decided (token feature key; minimized, no PII)
  fired_rule      jsonb,                                     -- {rule_id, rule_key, version} of the ONE applied rule; NULL = none fired / fail-closed base decision (FR-006/010)
  considered_rules jsonb,                                    -- array of {rule_id, rule_key, version} matched-but-not-applied by highest-priority-wins (FR-006/FR-014/SC-009); NULL/[] = none
  input_hash      text        NOT NULL,                      -- stable minimized CANONICAL hash of the decision context (stable key order -> reproducible, FR-005/SC-003/INV-12)
  input_snapshot  jsonb,                                     -- OPTIONAL minimized context snapshot; allow-listed, NO secret/PII (FR-017)
  decision        jsonb       NOT NULL,                      -- resolved (adjusted) entitlement value
  mode            text        NOT NULL                       -- enforced (issuance) | preview (report-only) | dry_run (simulate)
                    CHECK (mode IN ('enforced','preview','dry_run')),
  created_at      timestamptz NOT NULL DEFAULT now(),        -- append time; drives the BRIN retention prune
  PRIMARY KEY (tenant_id, id),
  -- enforced/preview run at issuance against a REAL license -> license_id required; only a dry_run may be synthetic.
  CONSTRAINT policy_evaluation_license_shape CHECK (mode = 'dry_run' OR license_id IS NOT NULL),
  -- intra-tenant composite FK (NULLABLE, MATCH SIMPLE): a real evaluation references a same-tenant license; a
  -- synthetic dry-run leaves it NULL (FK not enforced when null). ON DELETE NO ACTION: audit is retained.
  CONSTRAINT policy_evaluation_license_fk
    FOREIGN KEY (tenant_id, license_id) REFERENCES license (tenant_id, id) ON DELETE NO ACTION,
  -- intra-tenant composite FK (NULLABLE): the decided plan; NULL for a supplied/synthetic dry-run context.
  CONSTRAINT policy_evaluation_plan_fk
    FOREIGN KEY (tenant_id, plan_id)    REFERENCES plan    (tenant_id, id) ON DELETE NO ACTION,
  -- considered_rules must be a JSON array when present (matched-but-not-applied set; shape only, FR-006/SC-009).
  CONSTRAINT policy_evaluation_considered_array
    CHECK (considered_rules IS NULL OR jsonb_typeof(considered_rules) = 'array')
);

-- =====================================================================================================
-- Indexes (tenant_id-leading, matching the RLS predicate; E002 convention).
-- =====================================================================================================
-- Evaluation lookup (AD-005, FR-006): fetch a target entitlement's LIVE rules in deterministic priority order.
-- Highest-priority-wins scans (tenant, entitlement, status) ordered by priority DESC; (rule_key, version) is the
-- stable tiebreak, applied in the query.
CREATE INDEX policy_rule_eval ON policy_rule (tenant_id, entitlement_id, status, priority DESC);
-- Invariant: at most ONE live (active|preview) version per logical rule -> "the current version" is unambiguous;
-- a disabled/superseded version does not occupy the slot. Enforces the single-current-version lifecycle (AD-006).
CREATE UNIQUE INDEX policy_rule_one_live ON policy_rule (tenant_id, rule_key)
  WHERE status IN ('active','preview');

-- Per-license decision trail (US5/FR-014): "show me this license's evaluations" ordered by recency.
CREATE INDEX policy_evaluation_license ON policy_evaluation (tenant_id, license_id, created_at DESC)
  WHERE license_id IS NOT NULL;
-- Age-based retention prune (owner-role, like usage_event/billing_event) -> BRIN on the append-correlated time
-- column; a high-write append keeps created_at physically ordered, so BRIN is compact + fast.
CREATE INDEX policy_evaluation_prune ON policy_evaluation USING brin (created_at);

-- =====================================================================================================
-- RLS: same form as E002 (0002) / E007 (0006) / E014 (0010) / E016 (0012). Unset GUC -> NULL -> zero rows
-- (refuse unscoped access, SC-012); a cross-tenant reference -> not found (FR-015).
-- =====================================================================================================
ALTER TABLE policy_rule       ENABLE ROW LEVEL SECURITY; ALTER TABLE policy_rule       FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_evaluation ENABLE ROW LEVEL SECURITY; ALTER TABLE policy_evaluation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON policy_rule
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON policy_evaluation
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =====================================================================================================
-- Grants (least-privilege, non-owner licensesrv_app role).
-- =====================================================================================================
-- policy_rule: SELECT, INSERT (author / new immutable version) + UPDATE (status transition ONLY -- the repo
--   restricts UPDATE to status/updated_at; content columns are never updated). No app DELETE -- versions are
--   retained for audit/explainability; a GDPR/tenant erase runs on the OWNER role.
GRANT SELECT, INSERT, UPDATE ON policy_rule       TO licensesrv_app;
-- policy_evaluation: APPEND-ONLY (SELECT, INSERT) -- no app UPDATE/DELETE. The retention prune runs on the
--   OWNER role (the app role has NO DELETE grant), mirroring usage_event / billing_event.
GRANT SELECT, INSERT         ON policy_evaluation TO licensesrv_app;
-- The additive entitlement columns are covered by E007's existing table-level grant (no new grant needed).
