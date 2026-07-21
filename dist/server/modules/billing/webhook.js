import { privileged, withTenant } from "../../db/client.js";
import { getAdapter } from "./adapters/index.js";
import { resolveToleranceSecs } from "./config.js";
import { ConnectionRepo } from "./connection-repo.js";
import { isStaleEvent, mapEventToAction } from "./events.js";
import { BillingError } from "./index.js";
import { deadLetter, recordEvent } from "./ledger-repo.js";
import { applyGrace, applyProvision, applyRenew, applyRevoke, resolveSubscriptionByExternalId } from "./lifecycle.js";
import { getSubscriptionById } from "./subscription-repo.js";
import { verifySignature } from "./signature.js";
/** Thrown to force a clean ROLLBACK when a side-effect path discovers the event id was already recorded. */
class DuplicateRollback extends Error {
}
/** Build the append-only ledger row for the current event with a decided outcome/reason. */
function evtRow(event, subscriptionId, outcome, reason) {
    return {
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        subscriptionId,
        occurredAt: event.occurredAt,
        outcome,
        reason,
        payloadSummary: event.payloadSummary,
    };
}
/** Record a dead-letter and map it to the ack outcome (a conflicting redelivery acks `duplicate`). */
async function dead(q, event, subscriptionId, reason) {
    const dl = await deadLetter(q, {
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        subscriptionId,
        occurredAt: event.occurredAt,
        reason,
        payloadSummary: event.payloadSummary,
    });
    return dl.duplicate ? "duplicate" : "deadletter";
}
/** Lock the subscription row FOR UPDATE (serialize per-subscription processing) and re-read the latest state. */
async function lockSubscription(q, id) {
    const locked = await q("SELECT id FROM subscription WHERE id = $1 FOR UPDATE", [id]);
    if (!locked.rowCount)
        return null;
    return getSubscriptionById(q, id);
}
/** Pick a single header value by (lowercased) name; folds a repeated header to its first value. */
function pickHeader(headers, name) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value))
        return value[0];
    return value ?? undefined;
}
/** Map a signature-verification failure to its inline HTTP fault (FR-002); never leaks the secret/signature. */
function signatureFault(reason, toleranceSecs) {
    if (reason === "stale_timestamp" || reason === "future_timestamp") {
        return new BillingError("stale_timestamp", 400, "the signed timestamp is outside the recency tolerance", {
            toleranceSeconds: toleranceSecs,
        });
    }
    const detail = reason === "missing" ? "missing" : "mismatch"; // never echo the secret/signature material
    return new BillingError("invalid_signature", 401, "the webhook signature is missing or invalid", { reason: detail });
}
/**
 * Apply the mapped action inside the shared tx `q`, recording the ledger claim atomically with the side
 * effect. Returns the ack outcome. PROVISION creates the subscription (side effect BEFORE the claim, the FK
 * ordering); every other action claims the ledger BEFORE the side effect so a concurrent redelivery blocks on
 * the UNIQUE and becomes an idempotent no-op (HINT-002).
 */
async function dispatch(deps, q, tenantId, conn, event, now) {
    const action = mapEventToAction(event);
    // Resolve + lock the existing subscription (if any) so the stale guard reads and the apply are consistent.
    let sub = null;
    if (event.externalSubscriptionId) {
        const resolved = await resolveSubscriptionByExternalId(q, conn.provider, event.externalSubscriptionId);
        if (resolved)
            sub = await lockSubscription(q, resolved.id);
    }
    // --- PROVISION (subscription created/activated) ---
    if (action === "provision") {
        if (sub) {
            // Re-provision: claim BEFORE the reuse side effect so a redelivery does not re-audit.
            const claim = await recordEvent(q, evtRow(event, sub.id, "applied", null));
            if (claim.duplicate)
                return "duplicate";
            await applyProvision(deps, q, tenantId, conn, event, sub);
            return "applied";
        }
        // Create: issue + link (FK) FIRST, then claim the ledger row referencing the new subscription.
        const result = await applyProvision(deps, q, tenantId, conn, event, null);
        if (result.duplicate)
            throw new DuplicateRollback();
        if (!result.applied)
            return dead(q, event, null, result.reason ?? "unmapped_event");
        const claim = await recordEvent(q, evtRow(event, result.subscriptionId, "applied", null));
        if (claim.duplicate)
            throw new DuplicateRollback(); // the event id was already processed → roll back the create
        return "applied";
    }
    // --- NON-PROVISION (renew / past_due / cancel / revoke / ignore) ---
    if (!sub)
        return dead(q, event, null, "unmapped_event"); // no linked subscription
    // Stale/out-of-order guard (FR-016): older-or-equal than the last applied event → rejected, no state change.
    const anchor = sub.lastAppliedEventAt ? new Date(sub.lastAppliedEventAt) : null;
    if (isStaleEvent(event.occurredAt, anchor)) {
        await recordEvent(q, evtRow(event, sub.id, "rejected", "stale_event"));
        return "duplicate";
    }
    // An unhandled/unknown type dead-letters for operator attention (never an error).
    if (action === "ignore")
        return dead(q, event, sub.id, "unmapped_event");
    // renew / past_due / cancel / revoke: claim BEFORE the side effect (exactly-once under concurrent redelivery).
    const claim = await recordEvent(q, evtRow(event, sub.id, "applied", null));
    if (claim.duplicate)
        return "duplicate";
    if (action === "renew")
        await applyRenew(deps, q, tenantId, sub, event);
    else if (action === "revoke")
        await applyRevoke(deps, q, tenantId, sub, event); // FR-010 refund/chargeback → E008 revoke (terminal)
    else
        await applyGrace(deps, q, tenantId, conn, sub, event, action, now);
    return "applied";
}
/**
 * Ingest one signed billing webhook (FR-001/002/003). Verifies → dedupes → applies in one tenant tx and
 * returns the fast ack outcome. Genuine protocol faults throw `BillingError` (bad/missing signature → 401,
 * stale/future timestamp → 400, unknown connection → 404, malformed body → 400); refusals and no-ops are a
 * 200 ack with `outcome ∈ { applied, duplicate, deadletter }`.
 */
export async function handleWebhook(deps, input) {
    const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000);
    // 1. Resolve {connectionId} → tenant (privileged bootstrap; the id is an unguessable UUID, not an oracle).
    const owner = await privileged(deps.pool, (q) => q("SELECT tenant_id FROM billing_connection WHERE id = $1", [input.connectionId]));
    if (!owner.rowCount) {
        throw new BillingError("connection_not_found", 404, "unknown connection", { connectionId: input.connectionId });
    }
    const tenantId = owner.rows[0].tenant_id;
    const repo = new ConnectionRepo(deps.pool, deps.custody, deps.config);
    const toleranceSecs = resolveToleranceSecs(deps.config);
    try {
        const outcome = await withTenant(deps.pool, tenantId, async (q) => {
            // 2. Resolve the connection's unwrapped secret(s) + policy (internal; never returned/logged).
            const conn = await repo.resolveSecrets(q, input.connectionId);
            if (!conn)
                throw new BillingError("connection_not_found", 404, "unknown connection", { connectionId: input.connectionId });
            // The adapter defines both the provider signature header name and the normalization.
            const adapter = getAdapter(conn.provider);
            const signatureHeader = pickHeader(input.headers, adapter.signatureHeaderName);
            // 3. Verify the provider HMAC over the RAW body + timestamp recency BEFORE any parse (FR-002).
            const verified = verifySignature(input.rawBody, signatureHeader, conn.secretCurrent, conn.secretPrev, nowUnix, toleranceSecs);
            if (!verified.ok)
                throw signatureFault(verified.reason, toleranceSecs);
            // 4. Normalize the verified body (a validly-signed but unparseable body → 400; no ledger row).
            const event = adapter.normalize(input.rawBody);
            if (!event)
                throw new BillingError("validation_error", 400, "the webhook body could not be parsed");
            // A disabled connection still verifies (verify-before-process) but applies nothing → dead-letter.
            if (conn.status === "disabled")
                return dead(q, event, null, "connection_disabled");
            // 5. Dedupe-claim + apply the mapped action atomically.
            return dispatch(deps, q, tenantId, conn, event, new Date(nowUnix * 1000));
        });
        return { outcome };
    }
    catch (e) {
        if (e instanceof DuplicateRollback)
            return { outcome: "duplicate" };
        throw e;
    }
}
