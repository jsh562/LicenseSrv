// Policy-evaluation retention/prune worker (E017, FR-014; AD-008, INV-8; ADR-0014). A time-driven, unref'd,
// FAIL-OPEN, OWNER-ROLE maintenance job — modeled EXACTLY on the E016 usage retention worker / the E014 billing
// retention worker — that bounds the append-only `policy_evaluation` decision audit so its unified mode-marked
// trail (enforced|preview|dry_run) cannot grow forever. The app role holds SELECT/INSERT-only on
// `policy_evaluation` (NO DELETE — the trail is append-only, INV-8), so — exactly like the usage
// `retentionSweep` and the E013 `pruneExpiredCheckins` platform-owner path — the DELETE runs on the schema-OWNER
// (privileged, RLS-bypassing) connection, and each statement is scoped by an EXPLICIT per-tenant `tenant_id`
// predicate so no statement ever spans more than one tenant. Every prune is audited to a SYNTHETIC system actor
// (FR-014), counts only, no secret/credential/PII.
//
// RETENTION BY AGE (FR-014, AD-008): retention is a bounded, config-sourced age window (`policyEvaluationRetentionSecs`,
// ~90d). Everything strictly OLDER than `now - retention` is pruned; the `policy_evaluation_prune` BRIN(created_at)
// index backs the age scan (a high-write append keeps `created_at` physically ordered, so BRIN is compact + fast).
// The prune is idempotent — a re-run over an already-pruned window deletes zero rows. A prune fault must never
// block the live issuance/authoring surface, so the whole sweep is fail-open (it never throws).
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import { DEFAULT_EVALUATION_RETENTION_SECS } from "./config.js";

/** The synthetic system actor every automatic policy_evaluation prune is attributed to (FR-014). */
export const POLICY_RETENTION_ACTOR = "policy-retention-worker";

/** Default cadence (ms) — one prune sweep per hour (retention is a slow-moving bound, not latency-critical). */
export const DEFAULT_POLICY_RETENTION_INTERVAL_MS = 3_600_000;

/** A minimal structured logger for fail-open warnings + prune-count info (Fastify's `app.log` satisfies it). */
export interface PolicyRetentionLogger {
  warn(obj: object, msg?: string): void;
  info?(obj: object, msg?: string): void;
}

/** Options for a single {@link policyRetentionSweep}. */
export interface PolicyRetentionSweepOptions {
  /** Retention window in seconds; defaults to {@link DEFAULT_EVALUATION_RETENTION_SECS} (~90d). */
  retentionSecs?: number;
  /** Injectable clock; defaults to now. Tests pass a fixed instant for determinism. */
  now?: Date;
  /** Optional structured logger for fail-open warnings. */
  logger?: PolicyRetentionLogger;
  /** Optional per-tenant / sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** The outcome of one full prune sweep across all due tenants. */
export interface PolicyRetentionSweepResult {
  /** Tenants whose aged evaluation rows were pruned this pass. */
  tenants: number;
  /** Append-only `policy_evaluation` rows pruned across all tenants. */
  evaluations: number;
}

/** Enumerate the tenants with any aged evaluation row (privileged — the worker has no request tenant). */
async function listTenantsWithAgedEvaluations(pool: pg.Pool, cutoff: Date): Promise<string[]> {
  return privileged(pool, async (q) => {
    const r = await q("SELECT DISTINCT tenant_id FROM policy_evaluation WHERE created_at < $1", [cutoff]);
    return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
  });
}

/** Prune one tenant's aged `policy_evaluation` rows on the OWNER role (explicit tenant scope, BRIN-backed). */
async function pruneTenant(pool: pg.Pool, tenantId: string, cutoff: Date): Promise<number> {
  return privileged(pool, async (q) => {
    // Delete evaluation rows whose created_at is strictly before the retention cutoff. The BRIN
    // policy_evaluation_prune(created_at) index backs this age scan. Explicit tenant_id predicate → single-tenant.
    const d = await q("DELETE FROM policy_evaluation WHERE tenant_id = $1 AND created_at < $2", [tenantId, cutoff]);
    return d.rowCount ?? 0;
  });
}

/**
 * Run ONE prune sweep across every tenant with aged `policy_evaluation` rows (FR-014). FAIL-OPEN: a per-tenant
 * fault is caught + logged and never aborts the others, and the whole sweep never throws — a prune fault must
 * never block the live issuance/authoring surface. Returns the pruned counts; each tenant's prune is audited to
 * the synthetic actor (FR-014). The append-only audit trail's still-in-window rows survive.
 */
export async function policyRetentionSweep(
  pool: pg.Pool,
  options: PolicyRetentionSweepOptions = {},
): Promise<PolicyRetentionSweepResult> {
  const retentionSecs = options.retentionSecs ?? DEFAULT_EVALUATION_RETENTION_SECS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionSecs * 1000);

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "policy_retention_failed", context, error: err instanceof Error ? err.message : String(err) },
        "policy_evaluation retention prune failed (fail-open); the live issuance/authoring surface is unaffected",
      );
    } catch {
      /* logging is best-effort */
    }
    options.onError?.(err);
  };

  let tenants = 0;
  let evaluations = 0;

  try {
    const tenantIds = await listTenantsWithAgedEvaluations(pool, cutoff);
    for (const tenantId of tenantIds) {
      try {
        const pruned = await pruneTenant(pool, tenantId, cutoff);
        evaluations += pruned;
        if (pruned > 0) {
          tenants++;
          // Audit the prune to the synthetic actor (FR-014) — counts only, no secret/credential/PII.
          await withTenant(pool, tenantId, (q: TxQuery) =>
            writeAudit(q, {
              actor: POLICY_RETENTION_ACTOR,
              action: "policy.retention_pruned",
              after: { evaluations: pruned },
            }),
          ).catch((err) => warn(err, `retention audit for tenant ${tenantId}`));
        }
      } catch (err) {
        warn(err, `retention prune for tenant ${tenantId}`);
      }
    }
  } catch (err) {
    warn(err, "retention sweep");
  }

  return { tenants, evaluations };
}

/** Options for the periodic policy-retention worker (cadence + immediate + the sweep tuning). */
export interface PolicyRetentionWorkerOptions {
  /** Cadence in ms; default {@link DEFAULT_POLICY_RETENTION_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default false (retention is background maintenance, not boot-critical). */
  immediate?: boolean;
  /** Retention window in seconds (from the live policy config). */
  retentionSecs?: number;
  /** Optional structured logger for fail-open warnings + prune-count info. */
  logger?: PolicyRetentionLogger;
  /** Optional per-sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** A started policy-retention worker. `stop()` cancels the cadence; `runOnce()` runs a single fail-open prune. */
export interface PolicyRetentionWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

/**
 * Start the periodic policy_evaluation retention prune worker (FR-014). Fail-open and cancelable exactly like the
 * E016 usage retention worker / the E014 billing retention worker: the cadence timer is unref'd (never keeps the
 * process alive), overlapping sweeps are prevented by a running guard, and a prune fault is caught + logged and
 * never propagates (it re-fires on the next sweep, never crashing boot or blocking issuance). Wire from `main.ts`,
 * tied to `app.close()`.
 */
export function startPolicyRetentionWorker(
  pool: pg.Pool,
  options: PolicyRetentionWorkerOptions = {},
): PolicyRetentionWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_POLICY_RETENTION_INTERVAL_MS;
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      const { tenants, evaluations } = await policyRetentionSweep(pool, {
        retentionSecs: options.retentionSecs,
        logger: options.logger,
        onError: options.onError,
      });
      if (evaluations > 0) {
        options.logger?.info?.(
          { event: "policy_retention_pruned", tenants, evaluations },
          "pruned aged policy_evaluation audit rows (still-in-window trail retained)",
        );
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (options.immediate === true) void runOnce();

  return { stop: () => clearInterval(timer), runOnce };
}
