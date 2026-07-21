// Subscription repository (FR-007/008/009/012/016; AD-003/007, HINT-003). The external subscription<->license
// link + the grace OVERLAY. `license_id` is set ONCE at provisioning and is IMMUTABLE (inv.9): the mutation
// path (`applySubscriptionState`) touches ONLY billing_state / grace_expires_at / last_applied_event_at,
// never license_id, so a subscription is never re-linked. `last_applied_event_at` advances MONOTONICALLY via
// a guarded UPDATE (the recency guard, FR-016) -- never a DB trigger. The tx-composable functions take a
// `TxQuery` so the webhook can run resolve/link/apply IN ONE tenant transaction with the ledger insert +
// license side effect (HINT-002); the `SubscriptionRepo` class wraps a pool for standalone/admin use.
import { randomUUID } from "node:crypto";
import { withTenant } from "../../db/client.js";
import { BillingError } from "./index.js";
const SUB_SELECT = "id, provider, external_subscription_id, license_id, billing_state, grace_expires_at, last_applied_event_at, created_at, updated_at";
function toRecord(row) {
    return {
        id: row.id,
        provider: row.provider,
        externalSubscriptionId: row.external_subscription_id,
        licenseId: row.license_id,
        billingState: row.billing_state,
        graceExpiresAt: row.grace_expires_at ? row.grace_expires_at.toISOString() : null,
        lastAppliedEventAt: row.last_applied_event_at ? row.last_applied_event_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
/** Postgres unique-violation SQLSTATE (the `subscription_external_uniq` / `subscription_license_uniq` guards). */
function isUniqueViolation(e) {
    return typeof e === "object" && e !== null && e.code === "23505";
}
/** Resolve a subscription by its provider external id (the FR-012 resolve key), or null. Tx-composable. */
export async function resolveSubscriptionByExternalId(q, provider, externalSubscriptionId) {
    const r = await q(`SELECT ${SUB_SELECT} FROM subscription WHERE provider = $1 AND external_subscription_id = $2`, [
        provider,
        externalSubscriptionId,
    ]);
    return r.rowCount ? toRecord(r.rows[0]) : null;
}
/** Get a subscription by id, or null. Tx-composable. */
export async function getSubscriptionById(q, id) {
    const r = await q(`SELECT ${SUB_SELECT} FROM subscription WHERE id = $1`, [id]);
    return r.rowCount ? toRecord(r.rows[0]) : null;
}
/**
 * Create the subscription<->license link at provisioning (FR-005/012). `license_id` is set ONCE here and is
 * IMMUTABLE thereafter (inv.9). Throws `BillingError('duplicate_subscription', 409)` if the external id is
 * already linked or the license is already managed (the two UNIQUE guards). Tx-composable.
 */
export async function linkSubscription(q, input) {
    const id = randomUUID();
    try {
        const r = await q(`INSERT INTO subscription
         (id, tenant_id, provider, external_subscription_id, license_id, billing_state, grace_expires_at, last_applied_event_at)
       VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, $6, to_timestamp($7))
       RETURNING ${SUB_SELECT}`, [
            id,
            input.provider,
            input.externalSubscriptionId,
            input.licenseId,
            input.billingState ?? "active",
            input.graceExpiresAt ?? null,
            input.occurredAt ?? null,
        ]);
        return toRecord(r.rows[0]);
    }
    catch (e) {
        if (isUniqueViolation(e)) {
            throw new BillingError("duplicate_subscription", 409, "the subscription or license is already linked", {
                externalSubscriptionId: input.externalSubscriptionId,
            });
        }
        throw e;
    }
}
/**
 * Advance the subscription's overlay state under the MONOTONIC recency guard (FR-016; inv.9). Sets
 * `billing_state` + `grace_expires_at` + `last_applied_event_at` ONLY when `occurredAt` is strictly newer
 * than the current anchor (`last_applied_event_at IS NULL OR last_applied_event_at < to_timestamp(occurredAt)`)
 * -- so out-of-order delivery cannot regress state. NEVER touches `license_id`. Returns the updated record,
 * or null when the guard blocked it (a stale event) OR the id does not resolve in this tenant. Tx-composable.
 */
export async function applySubscriptionState(q, id, input) {
    const r = await q(`UPDATE subscription
        SET billing_state = $2,
            grace_expires_at = $3,
            last_applied_event_at = to_timestamp($4),
            updated_at = now()
      WHERE id = $1
        AND (last_applied_event_at IS NULL OR last_applied_event_at < to_timestamp($4))
      RETURNING ${SUB_SELECT}`, [id, input.billingState, input.graceExpiresAt, input.occurredAt]);
    return r.rowCount ? toRecord(r.rows[0]) : null;
}
/** List subscriptions (bounded, newest-first), optionally filtered (FR-012). Tx-composable. */
export async function listSubscriptions(q, filters) {
    const clauses = [];
    const params = [];
    if (filters.billingState) {
        params.push(filters.billingState);
        clauses.push(`billing_state = $${params.length}`);
    }
    if (filters.provider) {
        params.push(filters.provider);
        clauses.push(`provider = $${params.length}`);
    }
    if (filters.licenseId) {
        params.push(filters.licenseId);
        clauses.push(`license_id = $${params.length}`);
    }
    params.push(filters.cap);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await q(`SELECT ${SUB_SELECT} FROM subscription ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    return r.rows.map(toRecord);
}
/**
 * A thin pool-bound wrapper over the tx-composable functions for standalone / admin use (each method opens
 * its own `withTenant` RLS transaction). The webhook single-tx path uses the exported functions directly so
 * resolve/link/apply compose with the ledger insert + license side effect in ONE transaction (HINT-002).
 */
export class SubscriptionRepo {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    resolveByExternalId(tenantId, provider, externalSubscriptionId) {
        return withTenant(this.pool, tenantId, (q) => resolveSubscriptionByExternalId(q, provider, externalSubscriptionId));
    }
    getById(tenantId, id) {
        return withTenant(this.pool, tenantId, (q) => getSubscriptionById(q, id));
    }
    link(tenantId, input) {
        return withTenant(this.pool, tenantId, (q) => linkSubscription(q, input));
    }
    applyState(tenantId, id, input) {
        return withTenant(this.pool, tenantId, (q) => applySubscriptionState(q, id, input));
    }
    list(tenantId, filters) {
        return withTenant(this.pool, tenantId, (q) => listSubscriptions(q, filters));
    }
}
