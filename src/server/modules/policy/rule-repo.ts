// Policy-rule repository (E017, FR-011/014/015/019; ADR-0014, AD-006/AD-008, HINT-004, INV-2/INV-3/INV-8). The
// shared, tenant-scoped data-access surface the authoring routes + the issuance-path evaluator compose. Two
// orthogonal axes of the `policy_rule` lifecycle (data-model INV-2/INV-3) are honored HERE, at the repo layer:
//
//   - IMMUTABLE CONTENT (append-only): a content edit is a NEW `(rule_key, version+1)` row (`insertVersion`); a
//     prior version is NEVER mutated. `nextVersion` derives version+1 from the current MAX; the DB
//     `policy_rule_version_uniq` UNIQUE catches a concurrent duplicate.
//   - MUTABLE STATUS (the ONLY mutable column, INV-2): `updateStatus` is the SOLE update path and it restricts
//     the UPDATE to `status`/`updated_at` — it can never touch `condition`/`effect`/`priority`/`entitlement_id`/
//     `plan_id`/`rule_key`/`version`/`author`/`created_at`. A content change is always a new version, never an
//     in-place mutation (FR-011). (The table grants UPDATE, but this repo is the only writer and only flips
//     status — the content-immutability guarantee is a repo invariant, proven by the T020 integration test.)
//
// Every method takes the caller's tenant transaction `q` (a `withTenant` TxQuery), so each statement runs under
// forced RLS scoped to exactly one tenant: a cross-tenant id resolves to zero rows / not found (FR-015), and
// `tenant_id` comes from the transaction-local `app.current_tenant` GUC, never a caller argument. `policy_rule`
// is INSERT/UPDATE(status-only); `policy_evaluation` is APPEND-ONLY (INSERT) — no DELETE (retention prune is the
// owner-role path, INV-8). Mirrors the E016 `UsageRepo` idiom (stateless; parameterized raw SQL; GUC tenanting).
import { randomUUID } from "node:crypto";

import type { TxQuery } from "../../db/client.js";

/** The lifecycle status of a rule version (data-model): preview=report-only, active=enforced, disabled=inert. */
export type RuleStatus = "active" | "preview" | "disabled";

/** The evaluation mode a `policy_evaluation` row is marked with (AD-008, FR-014). */
export type EvaluationMode = "enforced" | "preview" | "dry_run";

/** A `policy_rule` version row (snake_case DB columns mapped to camelCase). */
export interface PolicyRuleRow {
  id: string;
  ruleKey: string;
  version: number;
  entitlementId: string;
  planId: string | null;
  condition: unknown;
  effect: unknown;
  priority: number;
  status: RuleStatus;
  author: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The immutable content of a new rule version to INSERT (a create is version=1; an edit is version+1). */
export interface InsertRuleInput {
  /** Optional explicit id (defaults to a fresh UUID). */
  id?: string;
  ruleKey: string;
  version: number;
  entitlementId: string;
  planId?: string | null;
  condition: unknown;
  effect: unknown;
  priority?: number;
  status?: RuleStatus;
  author: string;
}

/** Filters for {@link PolicyRuleRepo.listRules} (deterministic, bounded). */
export interface ListRulesFilter {
  entitlementId?: string | null;
  status?: RuleStatus | null;
  limit: number;
}

/** One append-only `policy_evaluation` audit row (AD-008, FR-014). `tenant_id` comes from the GUC under RLS. */
export interface AppendEvaluationInput {
  id?: string;
  /** NULL only for a supplied-context synthetic dry-run (the DB license-shape CHECK requires it for other modes). */
  licenseId?: string | null;
  planId?: string | null;
  entitlementKey: string;
  /** `{rule_id, rule_key, version}` of the ONE applied rule, or null when none fired / a fail-closed base decision. */
  firedRule?: unknown;
  /** Array of `{rule_id, rule_key, version}` matched-but-not-applied by highest-priority-wins (FR-006). */
  consideredRules?: unknown[] | null;
  /** The canonical minimized decision-context hash (INV-12, reproducible). */
  inputHash: string;
  /** Optional minimized context snapshot (allow-listed, no secret/PII, FR-017). */
  inputSnapshot?: unknown;
  /** The resolved (adjusted) entitlement decision. */
  decision: unknown;
  mode: EvaluationMode;
}

const RULE_COLUMNS =
  "id, rule_key, version, entitlement_id, plan_id, condition, effect, priority, status, author, created_at, updated_at";

/**
 * The shared, stateless policy-rule + evaluation-audit repository. Every method is driven by the caller's tenant
 * transaction `q`, so the same instance is safely shared across requests/workers (mirrors {@link UsageRepo}).
 */
export class PolicyRuleRepo {
  /**
   * INSERT a new immutable rule version (a create at version=1 OR an edit at version+1). Content columns are set
   * once here and never updated (INV-2); `status` defaults to `preview` (report-only) and `priority` to 0. The
   * DB `policy_rule_version_uniq` UNIQUE forbids a duplicate `(rule_key, version)`; `policy_rule_one_live`
   * forbids a second live (active|preview) version per `rule_key`. Returns the persisted row.
   */
  async insertVersion(q: TxQuery, input: InsertRuleInput): Promise<PolicyRuleRow> {
    const id = input.id ?? randomUUID();
    const r = await q(
      `INSERT INTO policy_rule
         (id, tenant_id, rule_key, version, entitlement_id, plan_id, condition, effect, priority, status, author)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       RETURNING ${RULE_COLUMNS}`,
      [
        id,
        input.ruleKey,
        input.version,
        input.entitlementId,
        input.planId ?? null,
        JSON.stringify(input.condition),
        JSON.stringify(input.effect),
        input.priority ?? 0,
        input.status ?? "preview",
        input.author,
      ],
    );
    return mapRule(r.rows[0] as PolicyRuleRow_);
  }

  /**
   * The next version number for a logical rule = `MAX(version) + 1` (1 when the rule_key is new). Immutable
   * versioning: an edit ADVANCES the version and INSERTs a fresh row rather than mutating a prior one (FR-011).
   */
  async nextVersion(q: TxQuery, ruleKey: string): Promise<number> {
    const r = await q(
      "SELECT COALESCE(MAX(version), 0)::int AS v FROM policy_rule WHERE rule_key = $1",
      [ruleKey],
    );
    return (r.rows[0] as { v: number }).v + 1;
  }

  /**
   * Transition a rule version's lifecycle status — the SOLE update path, restricted to `status`/`updated_at`
   * (INV-2). Content columns are NEVER in the SET list, so a content field can never be mutated through the
   * repo (a content change is a new version). Returns the updated row, or null when no such (rule_key, version)
   * exists in the tenant scope (RLS / not found). Enable/disable/preview flips status; `policy_rule_one_live`
   * still guarantees at most one live version per rule_key.
   */
  async updateStatus(
    q: TxQuery,
    p: { ruleKey: string; version: number; status: RuleStatus },
  ): Promise<PolicyRuleRow | null> {
    const r = await q(
      `UPDATE policy_rule SET status = $3, updated_at = now()
        WHERE rule_key = $1 AND version = $2
        RETURNING ${RULE_COLUMNS}`,
      [p.ruleKey, p.version, p.status],
    );
    if ((r.rowCount ?? 0) === 0) return null;
    return mapRule(r.rows[0] as PolicyRuleRow_);
  }

  /** Read one specific rule version (or null). RLS scopes it to the tenant (cross-tenant → not found, FR-015). */
  async getVersion(q: TxQuery, ruleKey: string, version: number): Promise<PolicyRuleRow | null> {
    const r = await q(
      `SELECT ${RULE_COLUMNS} FROM policy_rule WHERE rule_key = $1 AND version = $2`,
      [ruleKey, version],
    );
    if ((r.rowCount ?? 0) === 0) return null;
    return mapRule(r.rows[0] as PolicyRuleRow_);
  }

  /** The single live (active|preview) version of a logical rule, or null (INV-3 guarantees at most one). */
  async getLiveVersion(q: TxQuery, ruleKey: string): Promise<PolicyRuleRow | null> {
    const r = await q(
      `SELECT ${RULE_COLUMNS} FROM policy_rule
        WHERE rule_key = $1 AND status IN ('active','preview')
        ORDER BY version DESC LIMIT 1`,
      [ruleKey],
    );
    if ((r.rowCount ?? 0) === 0) return null;
    return mapRule(r.rows[0] as PolicyRuleRow_);
  }

  /**
   * The full immutable version history of a logical rule, newest version first (for the rule-detail read).
   * Empty when the rule_key is unknown in the tenant scope (RLS → not found, FR-015).
   */
  async getVersions(q: TxQuery, ruleKey: string): Promise<PolicyRuleRow[]> {
    const r = await q(
      `SELECT ${RULE_COLUMNS} FROM policy_rule WHERE rule_key = $1 ORDER BY version DESC`,
      [ruleKey],
    );
    return (r.rows as PolicyRuleRow_[]).map(mapRule);
  }

  /**
   * List rule versions, optionally narrowed to one entitlement and/or status, deterministically ordered
   * (`rule_key`, then `version DESC`) and bounded by `limit`. Deterministic ordering makes the `truncated`
   * signal (a caller reads `limit+1` to detect it) reproducible.
   */
  async listRules(q: TxQuery, f: ListRulesFilter): Promise<PolicyRuleRow[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.entitlementId) {
      params.push(f.entitlementId);
      where.push(`entitlement_id = $${params.length}`);
    }
    if (f.status) {
      params.push(f.status);
      where.push(`status = $${params.length}`);
    }
    params.push(f.limit);
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const r = await q(
      `SELECT ${RULE_COLUMNS} FROM policy_rule
        ${whereClause}
        ORDER BY rule_key ASC, version DESC
        LIMIT $${params.length}`,
      params,
    );
    return (r.rows as PolicyRuleRow_[]).map(mapRule);
  }

  /**
   * List ONE summary row per logical rule — its LATEST version (highest `version`) — optionally narrowed to a
   * target entitlement and/or the latest version's status, ordered DETERMINISTICALLY by `priority DESC` then the
   * stable `rule_key` tiebreak, bounded by `limit` (the caller reads `cap+1` to derive the `truncated` signal).
   * The entitlement filter (a content column, identical across a rule's versions) is applied in the inner
   * DISTINCT ON scan; the status filter is applied to the resolved latest version (the rule's current head).
   */
  async listLatestRules(
    q: TxQuery,
    f: { entitlementId?: string | null; status?: RuleStatus | null; limit: number },
  ): Promise<PolicyRuleRow[]> {
    const params: unknown[] = [];
    const innerWhere: string[] = [];
    if (f.entitlementId) {
      params.push(f.entitlementId);
      innerWhere.push(`entitlement_id = $${params.length}`);
    }
    const innerWhereClause = innerWhere.length > 0 ? `WHERE ${innerWhere.join(" AND ")}` : "";
    let outerWhere = "";
    if (f.status) {
      params.push(f.status);
      outerWhere = `WHERE status = $${params.length}`;
    }
    params.push(f.limit);
    const r = await q(
      `SELECT ${RULE_COLUMNS} FROM (
         SELECT DISTINCT ON (rule_key) ${RULE_COLUMNS}
           FROM policy_rule
           ${innerWhereClause}
          ORDER BY rule_key, version DESC
       ) latest
       ${outerWhere}
       ORDER BY priority DESC, rule_key ASC
       LIMIT $${params.length}`,
      params,
    );
    return (r.rows as PolicyRuleRow_[]).map(mapRule);
  }

  /**
   * The LIVE (active|preview) rules targeting one entitlement, in deterministic evaluation order
   * (`priority DESC`, then the stable `(rule_key, version)` tiebreak) — the highest-priority-wins scan input
   * (AD-005, FR-006). Bounded by `limit` (the per-issuance rule cap, FR-019). Served by the `policy_rule_eval`
   * index. Disabled versions are excluded (they never evaluate).
   */
  async selectLiveRulesForEntitlement(
    q: TxQuery,
    entitlementId: string,
    limit: number,
  ): Promise<PolicyRuleRow[]> {
    const r = await q(
      `SELECT ${RULE_COLUMNS} FROM policy_rule
        WHERE entitlement_id = $1 AND status IN ('active','preview')
        ORDER BY priority DESC, rule_key ASC, version DESC
        LIMIT $2`,
      [entitlementId, limit],
    );
    return (r.rows as PolicyRuleRow_[]).map(mapRule);
  }

  /**
   * Count the tenant's LIVE (active|preview) rule versions — the author-time rule-set size the FR-019 per-tenant
   * cap checks (over it → `rule_set_limit_exceeded`, refused before persist). RLS scopes the count to the tenant.
   */
  async countLiveRulesForTenant(q: TxQuery): Promise<number> {
    const r = await q(
      "SELECT count(*)::int AS n FROM policy_rule WHERE status IN ('active','preview')",
    );
    return (r.rows[0] as { n: number }).n;
  }

  /** Count the LIVE (active|preview) rule versions targeting one entitlement (the FR-019 per-entitlement cap). */
  async countLiveRulesForEntitlement(q: TxQuery, entitlementId: string): Promise<number> {
    const r = await q(
      "SELECT count(*)::int AS n FROM policy_rule WHERE entitlement_id = $1 AND status IN ('active','preview')",
      [entitlementId],
    );
    return (r.rows[0] as { n: number }).n;
  }

  /**
   * Append ONE mode-marked `policy_evaluation` audit row (AD-008, FR-014, INV-8). Append-only — the app role has
   * no UPDATE/DELETE on this table; the retention prune is the owner-role path. Records the fired rule id+version
   * (or null), the considered-but-not-applied set, the canonical input hash (+ optional snapshot), and the
   * resolved decision, distinctly marked enforced|preview|dry_run. Returns the new row id.
   */
  async appendEvaluation(q: TxQuery, input: AppendEvaluationInput): Promise<string> {
    const id = input.id ?? randomUUID();
    await q(
      `INSERT INTO policy_evaluation
         (id, tenant_id, license_id, plan_id, entitlement_key, fired_rule, considered_rules,
          input_hash, input_snapshot, decision, mode)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5::jsonb, $6::jsonb,
               $7, $8::jsonb, $9::jsonb, $10)`,
      [
        id,
        input.licenseId ?? null,
        input.planId ?? null,
        input.entitlementKey,
        input.firedRule === undefined ? null : JSON.stringify(input.firedRule),
        input.consideredRules == null ? null : JSON.stringify(input.consideredRules),
        input.inputHash,
        input.inputSnapshot === undefined ? null : JSON.stringify(input.inputSnapshot),
        JSON.stringify(input.decision),
        input.mode,
      ],
    );
    return id;
  }
}

// --- Row mapper (snake_case DB columns -> camelCase record) ------------------------------------------
interface PolicyRuleRow_ {
  id: string;
  rule_key: string;
  version: number;
  entitlement_id: string;
  plan_id: string | null;
  condition: unknown;
  effect: unknown;
  priority: number;
  status: RuleStatus;
  author: string;
  created_at: Date;
  updated_at: Date;
}

function mapRule(row: PolicyRuleRow_): PolicyRuleRow {
  return {
    id: row.id,
    ruleKey: row.rule_key,
    version: Number(row.version),
    entitlementId: row.entitlement_id,
    planId: row.plan_id,
    condition: row.condition,
    effect: row.effect,
    priority: Number(row.priority),
    status: row.status,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
