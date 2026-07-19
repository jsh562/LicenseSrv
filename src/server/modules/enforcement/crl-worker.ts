// CRL publication worker (FR-009/019; US4; AD-003/004). A periodic background job that, per (tenant,
// product) with revocations, regenerates the signed CRL when the revoked-id set CHANGED or the current CRL's
// `next_update` has ELAPSED, and audits each publication (`crl.published`). Mirrors the E012 canary
// fail-open worker pattern: the cadence timer is unref'd (never keeps the process alive), a fault on one
// tenant/product never aborts the others, and NO fault ever throws out of the worker or crashes the app —
// the CRL is belt-and-braces (the client fails OPEN if it is missing/stale, FR-011). Wiring into main.ts is
// a later Polish step; `startCrlWorker` is exported now so it can be started fail-open like the canary.
import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import type { Signer } from "../signing/signer.js";
import { type EnforcementConfig, resolvePlanWindows, type PlanWindows } from "./config.js";
import { generateCrl, getLatestCrl, projectRevokedIds, type RevokedIds } from "./crl.js";

const ACTOR = "crl-worker";

/** Default cadence (ms) — one publication sweep per minute. Low enough to propagate a revocation promptly. */
export const DEFAULT_CRL_WORKER_INTERVAL_MS = 60_000;

/** A minimal structured logger the worker uses for fail-open warnings (Fastify's `app.log` satisfies it). */
export interface CrlWorkerLogger {
  warn(obj: object, msg?: string): void;
}

export interface CrlWorkerOptions {
  /** Cadence in ms; default {@link DEFAULT_CRL_WORKER_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default true. Tests pass false and drive `runOnce` deterministically. */
  immediate?: boolean;
  /** Optional structured logger for fail-open warnings. */
  logger?: CrlWorkerLogger;
  /** Optional hook invoked with the error on a per-tenant/per-product/sweep failure (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** A started CRL worker. `stop()` cancels the cadence; `runOnce()` runs a single sweep (used by tests). */
export interface CrlWorkerHandle {
  /** Cancel the cadence timer. Idempotent and safe to call after a fail-open no-op start. */
  stop(): void;
  /** Run exactly one publication sweep now (never rejects — every fault is caught and logged fail-open). */
  runOnce(): Promise<void>;
}

const sameSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
};

const sameRevokedIds = (a: RevokedIds, b: RevokedIds): boolean =>
  sameSet(a.licenses, b.licenses) && sameSet(a.activations, b.activations);

/**
 * Enumerate the tenants that could need a CRL: any with a revoked license, a deactivated activation, or an
 * already-published CRL (so an elapsed `next_update` still gets refreshed). Runs on the privileged
 * (RLS-bypassing) role because the worker has no request tenant context; it only reads distinct tenant ids,
 * never row data — the per-tenant work below re-enters under `withTenant` (RLS) to touch actual rows.
 */
async function listTenantsWithRevocations(pool: pg.Pool): Promise<string[]> {
  return privileged(pool, async (q) => {
    const r = await q(
      `SELECT DISTINCT tenant_id FROM license WHERE status = 'revoked'
       UNION
       SELECT DISTINCT tenant_id FROM activation WHERE status = 'deactivated'
       UNION
       SELECT DISTINCT tenant_id FROM revocation_list`,
    );
    return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
  });
}

/** The candidate products (within the current tenant scope) that could need a CRL — same three sources. */
async function listCandidateProducts(q: TxQuery): Promise<string[]> {
  const r = await q(
    `SELECT DISTINCT product_id FROM license WHERE status = 'revoked'
     UNION
     SELECT DISTINCT l.product_id FROM activation a JOIN license l ON l.id = a.license_id WHERE a.status = 'deactivated'
     UNION
     SELECT DISTINCT product_id FROM revocation_list`,
  );
  return (r.rows as { product_id: string }[]).map((x) => x.product_id);
}

/**
 * Publish (regenerate + audit) the CRL for one (tenant, product) IF it is stale — the revoked set changed
 * or the current version's `next_update` has elapsed. A no-content product with no prior CRL is skipped
 * (nothing to publish). Runs in its OWN `withTenant` tx so one product's fault cannot roll back another's.
 */
async function publishIfStale(
  pool: pg.Pool,
  tenantId: string,
  productId: string,
  signer: Signer,
  windows: PlanWindows,
): Promise<void> {
  await withTenant(pool, tenantId, async (q) => {
    const current = await projectRevokedIds(q, productId);
    const latest = await getLatestCrl(q, tenantId, productId);
    const hasContent = current.licenses.length + current.activations.length > 0;

    // Nothing to publish for a product that has no revocations and no prior CRL.
    if (!hasContent && !latest) return;

    const changed = latest === null || !sameRevokedIds(latest.revokedIds, current);
    const stale = latest !== null && Date.parse(latest.nextUpdate) <= Date.now();
    if (!changed && !stale) return;

    const record = await generateCrl(q, tenantId, productId, signer, windows);
    await writeAudit(q, {
      actor: ACTOR,
      action: "crl.published",
      target: productId,
      after: { version: record.version, licenses: record.revokedIds.licenses.length, activations: record.revokedIds.activations.length },
    });
  });
}

/**
 * Start the CRL publication worker (FR-009). Returns a stop handle. Fail-open and cancelable exactly like
 * the E012 canary: the cadence timer is unref'd, a fault on any tenant/product/sweep is caught + logged and
 * never propagates, and overlapping sweeps are prevented by a running guard. With no signer configured the
 * worker no-ops (a CRL cannot be signed without the E004 key — fail-open, the client's short-token TTL still
 * bounds staleness). `windows` come from the deployment defaults (a CRL is per-product, not per-plan).
 */
export function startCrlWorker(
  pool: pg.Pool,
  signer: Signer | undefined,
  config: EnforcementConfig,
  options: CrlWorkerOptions = {},
): CrlWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_CRL_WORKER_INTERVAL_MS;
  const windows = resolvePlanWindows(config);
  let running = false;

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "crl_worker_failed", context, error: err instanceof Error ? err.message : String(err) },
        "CRL worker step failed (fail-open); the client falls back to short-token-TTL enforcement",
      );
    } catch {
      /* logging is best-effort */
    }
    options.onError?.(err);
  };

  const runOnce = async (): Promise<void> => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      if (!signer) return; // no key → cannot sign a CRL; fail-open no-op
      const tenantIds = await listTenantsWithRevocations(pool);
      for (const tenantId of tenantIds) {
        let products: string[];
        try {
          products = await withTenant(pool, tenantId, (q) => listCandidateProducts(q));
        } catch (err) {
          warn(err, `enumerate products for tenant ${tenantId}`);
          continue;
        }
        for (const productId of products) {
          try {
            await publishIfStale(pool, tenantId, productId, signer, windows);
          } catch (err) {
            // Per-product fail-open: a signer fault or a version race on one product never blocks the rest.
            warn(err, `publish CRL for product ${productId}`);
          }
        }
      }
    } catch (err) {
      warn(err, "sweep");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  // Never let the worker keep the process alive — it is best-effort background publication (fail-open).
  if (typeof timer.unref === "function") timer.unref();

  if (options.immediate !== false) void runOnce();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
