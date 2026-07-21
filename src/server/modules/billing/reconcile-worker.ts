// Reconciliation & missed-event recovery (FR-016/017/013; AD-006/007, HINT-005). A periodic + on-demand
// self-heal: for each active connection's managed subscription it fetches the provider's AUTHORITATIVE
// subscription state via an INJECTABLE `providerFetch` (a real provider-API adapter in production; STUBBED in
// tests — there is no live provider in the test/self-host default), diffs it against the local billing
// overlay, and applies the correcting action through the SAME E014 lifecycle apply-actions the webhook path
// uses (so a missed cancel → grace, a missed refund → revoke, a missed payment → recover). Every correction
// is RECENCY-GUARDED (FR-016 — an authoritative snapshot no newer than `last_applied_event_at` is ignored so
// reconciliation never regresses newer webhook-applied state), FAIL-OPEN (a provider/DB fault on one
// subscription never aborts the rest and never crashes the app — the E013 CRL-worker pattern), and audited
// with a SYNTHETIC system actor + the subscription id + the reconciliation job id (NO provider event id,
// FR-013). Terminal `refunded`/revoked subscriptions are skipped (a revoked license is never resurrected).
import { randomUUID } from "node:crypto";

import { privileged, withTenant, type TxQuery } from "../../db/client.js";
import { isStaleEvent, type CanonicalEvent, type CanonicalEventType, type Provider } from "./events.js";
import type { BillingDeps } from "./index.js";
import type { ResolvedConnection } from "./connection-repo.js";
import { applyGrace, applyRenew, applyRevoke, RECONCILE_ACTOR, type MutationContext } from "./lifecycle.js";
import { getSubscriptionById, type BillingState, type SubscriptionRecord } from "./subscription-repo.js";

/**
 * The provider's AUTHORITATIVE view of one subscription, as fetched from the provider API. The reconcile
 * worker diffs this against the local overlay and self-heals any drift. `status` is normalized to the
 * canonical billing-lifecycle intent; `occurredAt` (epoch seconds) drives the recency guard (defaults to the
 * reconcile clock when the provider carries none). NO card/PAN/PII is ever read here (FR-018).
 */
export interface AuthoritativeSubscription {
  /** The provider's authoritative billing status, normalized to the canonical intent. */
  status: "active" | "past_due" | "canceled" | "refunded";
  /** The provider's state timestamp (epoch seconds); the recency-guard ordering key. Defaults to now. */
  occurredAt?: number;
  /** The current period end (epoch seconds) — pushes the linked license term forward on an `active` recovery. */
  periodEndUnix?: number | null;
  /** The provider plan/price key (per-plan grace resolution); defaults to the subscription's link when absent. */
  planKey?: string | null;
}

/** What the worker asks the provider adapter about one subscription. */
export interface ProviderFetchInput {
  provider: Provider;
  externalSubscriptionId: string;
}

/**
 * The INJECTABLE provider-state fetch (AD-005/006). Returns the provider's authoritative state for a
 * subscription, or null when the provider has no record / cannot be reached (→ that subscription is skipped,
 * fail-open). A real provider-API adapter in production; a deterministic stub in tests (there is no live
 * provider). NEVER reads card/PAN/PII.
 */
export type ProviderFetch = (input: ProviderFetchInput) => Promise<AuthoritativeSubscription | null>;

/** The default provider fetch: no live provider is wired, so reconciliation is a no-op (fail-open). */
export const noopProviderFetch: ProviderFetch = async () => null;

/** Reconciliation scope — the whole tenant, one connection (by provider), or one subscription. */
export interface ReconcileScope {
  tenantId: string;
  connectionId?: string;
  subscriptionId?: string;
}

export interface ReconcileOptions {
  /** Correlation id stamped into every correction's audit (`reconcileJobId`); generated when absent. */
  jobId?: string;
  /** The reconcile clock (epoch seconds); defaults to now. Injected by tests for determinism. */
  nowUnix?: number;
  /** Optional structured logger for fail-open warnings (Fastify's `app.log` satisfies it). */
  logger?: { warn(obj: object, msg?: string): void };
  /** Optional per-subscription/sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

export interface ReconcileResult {
  jobId: string;
  scope: "tenant" | "connection" | "subscription";
  /** Subscriptions examined against the provider. */
  examined: number;
  /** Subscriptions whose drift was corrected. */
  corrected: number;
}

/** A subscription candidate for reconciliation (an active connection's managed, non-terminal subscription). */
interface Candidate {
  id: string;
  provider: Provider;
  externalSubscriptionId: string;
}

/** The canonical event type + billing action the authoritative status maps onto. */
function statusToAction(
  status: AuthoritativeSubscription["status"],
): { action: "renew" | "cancel" | "past_due" | "revoke"; type: CanonicalEventType; desired: BillingState } {
  switch (status) {
    case "active":
      return { action: "renew", type: "subscription.renewed", desired: "active" };
    case "past_due":
      return { action: "past_due", type: "subscription.payment_failed", desired: "past_due" };
    case "canceled":
      return { action: "cancel", type: "subscription.canceled", desired: "grace" };
    case "refunded":
      return { action: "revoke", type: "subscription.refunded", desired: "refunded" };
  }
}

/**
 * Is a correction to `desired` needed given the current local overlay? Refunded is terminal (always
 * corrected unless already refunded). `active` recovers from any non-active overlay. A `canceled`
 * authoritative maps to a grace overlay, so it corrects only when the local overlay is still active/past_due
 * (already in grace/canceled/refunded → no drift). `past_due` corrects only from active.
 */
function driftsTo(local: BillingState, status: AuthoritativeSubscription["status"]): boolean {
  switch (status) {
    case "refunded":
      return local !== "refunded";
    case "active":
      return local !== "active";
    case "canceled":
      return local === "active" || local === "past_due";
    case "past_due":
      return local === "active";
  }
}

/** Resolve the connection's grace policy for a provider (secret excluded — reconcile never needs it). */
async function resolvePolicyConnection(q: TxQuery, provider: Provider): Promise<ResolvedConnection | null> {
  const r = await q(
    `SELECT id, provider, status, plan_map, default_grace_seconds, grace_overrides
       FROM billing_connection_public WHERE provider = $1`,
    [provider],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as {
    id: string;
    provider: Provider;
    status: "active" | "disabled";
    plan_map: ResolvedConnection["planMap"];
    default_grace_seconds: number;
    grace_overrides: Record<string, number>;
  };
  // The secret buffers are intentionally empty: the reconcile grace path reads only the grace policy, never
  // the inbound-HMAC secret (that is the webhook-verify path's concern).
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    secretCurrent: Buffer.alloc(0),
    secretPrev: null,
    planMap: row.plan_map,
    defaultGraceSeconds: row.default_grace_seconds,
    graceOverrides: row.grace_overrides,
  };
}

/** Enumerate the reconcile candidates for a scope within the current tenant transaction. */
async function listCandidates(q: TxQuery, scope: ReconcileScope): Promise<Candidate[]> {
  const clauses: string[] = ["c.status = 'active'", "s.billing_state <> 'refunded'"];
  const params: unknown[] = [];
  if (scope.subscriptionId) {
    params.push(scope.subscriptionId);
    clauses.push(`s.id = $${params.length}`);
  }
  if (scope.connectionId) {
    params.push(scope.connectionId);
    clauses.push(`c.id = $${params.length}`);
  }
  const r = await q(
    `SELECT s.id, s.provider, s.external_subscription_id
       FROM subscription s
       JOIN billing_connection c ON c.tenant_id = s.tenant_id AND c.provider = s.provider
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.created_at ASC`,
    params,
  );
  return (r.rows as { id: string; provider: Provider; external_subscription_id: string }[]).map((x) => ({
    id: x.id,
    provider: x.provider,
    externalSubscriptionId: x.external_subscription_id,
  }));
}

/** Synthesize a canonical event carrying the authoritative snapshot for the lifecycle apply-actions. */
function synthEvent(
  provider: Provider,
  sub: Candidate,
  auth: AuthoritativeSubscription,
  type: CanonicalEventType,
  occurredAt: number,
): CanonicalEvent {
  return {
    provider,
    providerEventId: `reconcile:${sub.externalSubscriptionId}`, // never persisted — reconcile writes no ledger row
    type,
    externalSubscriptionId: sub.externalSubscriptionId,
    planKey: auth.planKey ?? null,
    periodEndUnix: auth.periodEndUnix ?? null,
    occurredAt,
    payloadSummary: {},
  };
}

/**
 * Reconcile one subscription in its OWN tenant transaction against a pre-fetched authoritative snapshot.
 * Re-reads the subscription under lock, applies the recency guard (FR-016) + drift check, then drives the
 * correcting action through the E014 lifecycle with the SYNTHETIC reconcile actor + source (FR-013). Returns
 * true when a correction was applied.
 */
async function reconcileOne(
  deps: BillingDeps,
  tenantId: string,
  sub: Candidate,
  auth: AuthoritativeSubscription,
  jobId: string,
  nowUnix: number,
): Promise<boolean> {
  const occurredAt = auth.occurredAt ?? nowUnix;
  const { action, type, desired } = statusToAction(auth.status);
  const ctx: MutationContext = { actor: RECONCILE_ACTOR, source: { subscriptionId: sub.id, reconcileJobId: jobId } };

  return withTenant(deps.pool, tenantId, async (q): Promise<boolean> => {
    const locked = await q("SELECT id FROM subscription WHERE id = $1 FOR UPDATE", [sub.id]);
    if (!locked.rowCount) return false;
    const current = await getSubscriptionById(q, sub.id);
    if (!current) return false;

    // Recency guard (FR-016): an authoritative snapshot no newer than the last applied event is ignored so a
    // reconciliation pass can never regress newer webhook-applied state (applied on BOTH paths, T043).
    if (isStaleEvent(occurredAt, current.lastAppliedEventAt ? new Date(current.lastAppliedEventAt) : null)) return false;
    if (!driftsTo(current.billingState, auth.status)) return false;

    const record: SubscriptionRecord = current;
    const event = synthEvent(sub.provider, sub, auth, type, occurredAt);
    if (action === "renew") {
      await applyRenew(deps, q, tenantId, record, event, ctx);
    } else if (action === "revoke") {
      await applyRevoke(deps, q, tenantId, record, event, ctx);
    } else {
      const conn = await resolvePolicyConnection(q, sub.provider);
      if (!conn) return false; // no active connection policy → skip (fail-open)
      await applyGrace(deps, q, tenantId, conn, record, event, action, new Date(nowUnix * 1000), ctx);
    }
    return true;
  });
}

/**
 * Reconcile a scope against the provider's authoritative state (FR-017; on-demand + periodic). Enumerates the
 * candidates, fetches each provider state OUTSIDE the DB transaction (no lock held across the network call),
 * and applies each correction in its own fail-open tenant transaction. Never throws for a per-subscription
 * fault — the whole pass is best-effort self-heal. Returns the job id, resolved scope, and counters.
 */
export async function reconcile(
  deps: BillingDeps,
  providerFetch: ProviderFetch,
  scope: ReconcileScope,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const jobId = options.jobId ?? randomUUID();
  const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const scopeLabel: ReconcileResult["scope"] = scope.subscriptionId
    ? "subscription"
    : scope.connectionId
      ? "connection"
      : "tenant";

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "reconcile_failed", context, error: err instanceof Error ? err.message : String(err) },
        "reconcile step failed (fail-open); it retries on the next pass",
      );
    } catch {
      /* logging is best-effort */
    }
    options.onError?.(err);
  };

  let candidates: Candidate[] = [];
  try {
    candidates = await withTenant(deps.pool, scope.tenantId, (q) => listCandidates(q, scope));
  } catch (err) {
    warn(err, `enumerate candidates for tenant ${scope.tenantId}`);
    return { jobId, scope: scopeLabel, examined: 0, corrected: 0 };
  }

  let examined = 0;
  let corrected = 0;
  for (const sub of candidates) {
    examined += 1;
    try {
      const auth = await providerFetch({ provider: sub.provider, externalSubscriptionId: sub.externalSubscriptionId });
      if (!auth) continue; // provider has no record / unreachable → skip (fail-open)
      if (await reconcileOne(deps, scope.tenantId, sub, auth, jobId, nowUnix)) corrected += 1;
    } catch (err) {
      // Per-subscription fail-open: a provider/DB fault on one never blocks the rest.
      warn(err, `reconcile subscription ${sub.id}`);
    }
  }
  return { jobId, scope: scopeLabel, examined, corrected };
}

/** Default periodic reconcile cadence (ms) — one sweep per 15 minutes (provider-friendly). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 900_000;

export interface ReconcileWorkerOptions {
  /** Cadence in ms; default {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Run one sweep immediately on start; default false (reconciliation is background self-heal, not boot-critical). */
  immediate?: boolean;
  /** Optional structured logger for fail-open warnings. */
  logger?: { warn(obj: object, msg?: string): void };
  /** Optional per-sweep failure hook (diagnostics/tests). */
  onError?: (err: unknown) => void;
}

/** A started reconcile worker. `stop()` cancels the cadence; `runOnce()` runs a single fail-open sweep. */
export interface ReconcileWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

/** Enumerate the tenants with at least one active-connection managed subscription (privileged read). */
async function listTenantsToReconcile(deps: BillingDeps): Promise<string[]> {
  return privileged(deps.pool, async (q) => {
    const r = await q(
      `SELECT DISTINCT s.tenant_id
         FROM subscription s
         JOIN billing_connection c ON c.tenant_id = s.tenant_id AND c.provider = s.provider
        WHERE c.status = 'active' AND s.billing_state <> 'refunded'`,
    );
    return (r.rows as { tenant_id: string }[]).map((x) => x.tenant_id);
  });
}

/**
 * Start the periodic reconciliation worker (FR-017). Fail-open and cancelable exactly like the E013 CRL
 * worker / the grace worker: the cadence timer is unref'd, a fault on any tenant/sweep is caught + logged and
 * never propagates, and overlapping sweeps are prevented by a running guard. With the default
 * {@link noopProviderFetch} (no live provider wired) each sweep is a no-op. Tied to `app.close()` from main.ts.
 */
export function startReconcileWorker(
  deps: BillingDeps,
  providerFetch: ProviderFetch,
  options: ReconcileWorkerOptions = {},
): ReconcileWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  let running = false;

  const warn = (err: unknown, context: string): void => {
    try {
      options.logger?.warn(
        { event: "reconcile_worker_failed", context, error: err instanceof Error ? err.message : String(err) },
        "reconcile worker step failed (fail-open); it retries on the next sweep",
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
      const tenantIds = await listTenantsToReconcile(deps);
      for (const tenantId of tenantIds) {
        try {
          await reconcile(deps, providerFetch, { tenantId }, { logger: options.logger, onError: options.onError });
        } catch (err) {
          warn(err, `reconcile tenant ${tenantId}`);
        }
      }
    } catch (err) {
      warn(err, "sweep");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  if (options.immediate === true) void runOnce();

  return { stop: () => clearInterval(timer), runOnce };
}
