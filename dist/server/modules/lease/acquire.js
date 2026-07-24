// Lease acquisition service (E015, FR-003/004/005/006/014/022/023/025; ADR-0012). Composes the foundational
// blocks into the race-safe acquire path: entitlement fail-closed (absent max_concurrent → 403), live license
// state (suspended/revoked/expired → 409), scope→holder-key derivation (FR-023), optional "activated-devices-
// only" gating (FR-025), the per-license advisory-lock count+insert (LeaseRepo.acquire, AD-001/FR-003), the
// single-use acquire-token replay (FR-014), and the E004-signed short-TTL lease handle (FR-022). A signer
// fault while signed-handle mode is on fails CLOSED (503) with NO seat consumed and no lease persisted — the
// sign happens inside the seat transaction, so a throw rolls the whole acquire back (SC-021). The soft-cap
// effective-cap admission (effectiveCap = max_concurrent + concurrency_overage) is enforced race-safely by
// LeaseRepo.acquire (AD-001); each fresh over-base seat is metered to the append-only audit log (FR-013).
// [COMPLETES FR-005, FR-006, FR-023, FR-003, FR-004, FR-014, FR-025, FR-012, FR-013]
import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { SignerError } from "../signing/signer.js";
import { resolveScope, resolveTimings } from "./config.js";
import { signLeaseHandle } from "./handle.js";
import { deriveHolderKey, HolderKeyError } from "./holder-key.js";
import { LeaseError } from "./index.js";
const ACTOR = "lease-api";
const LICENSE_LEASE_SELECT = `
  lic.id, lic.product_id, lic.plan_id, lic.status, lic.expires_at,
  lic.max_concurrent, lic.concurrency_scope, lic.concurrency_overage,
  lic.lease_heartbeat_seconds, lic.lease_ttl_seconds, lic.lease_grace_seconds, lic.lease_sweep_seconds,
  p.lease_signed_handle, p.concurrency_require_activation`;
function mapLicense(row) {
    return {
        id: row.id,
        productId: row.product_id,
        planId: row.plan_id,
        status: row.status,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
        maxConcurrent: row.max_concurrent,
        scope: resolveScope(row.concurrency_scope),
        overageAllowance: row.concurrency_overage,
        timings: resolveTimings({
            heartbeatSeconds: row.lease_heartbeat_seconds,
            ttlSeconds: row.lease_ttl_seconds,
            graceSeconds: row.lease_grace_seconds,
            sweepSeconds: row.lease_sweep_seconds,
        }),
        signedHandle: row.lease_signed_handle,
        requireActivation: row.concurrency_require_activation,
    };
}
/**
 * Resolve a license (+ its live plan toggles) for the lease surface, by internal id OR by its signed LIC1
 * token. A cross-tenant / unknown reference resolves to `null` under RLS (FR-019). Shared by acquire (by id/
 * key) and renew (by the lease's stored license id).
 */
export async function resolveLicenseForLease(q, by) {
    const where = by.token !== undefined ? "lic.license_token = $1" : "lic.id = $1";
    const arg = by.token !== undefined ? by.token : by.id;
    const r = await q(`SELECT ${LICENSE_LEASE_SELECT}
       FROM license lic
       JOIN plan p ON p.tenant_id = lic.tenant_id AND p.id = lic.plan_id
      WHERE ${where}`, [arg]);
    return r.rowCount ? mapLicense(r.rows[0]) : null;
}
/** Assemble the wire {@link LeaseGrant} from a lease row + the resolved cap/timings + the (optional) handle. */
export function buildGrant(lease, opts) {
    return {
        id: lease.id,
        licenseId: lease.licenseId,
        holderKey: lease.holderKey,
        scope: lease.scope,
        status: lease.status,
        acquiredAt: lease.acquiredAt,
        lastRenewedAt: lease.lastRenewedAt,
        expiresAt: lease.expiresAt,
        ttlSeconds: opts.timings.ttlSeconds,
        heartbeatIntervalSeconds: opts.timings.heartbeatSeconds,
        graceSeconds: opts.timings.graceSeconds,
        concurrencyUsed: opts.concurrencyUsed,
        maxConcurrent: opts.maxConcurrent,
        overageAllowance: opts.overageAllowance,
        overage: opts.overage,
        keyId: opts.keyId,
        leaseHandle: opts.leaseHandle,
    };
}
/**
 * Fail-closed entitlement + live-state check (FR-005/006). Throws the distinct business refusal: no
 * `max_concurrent` → 403 `no_concurrency_entitlement`; suspended/revoked/expired → 409 `license_not_active`
 * with the reason in `details.status`. Returns the base cap once the license is admissible.
 */
function assertEntitledAndActive(license) {
    if (license.maxConcurrent == null) {
        throw new LeaseError("no_concurrency_entitlement", 403, "the license has no concurrency entitlement");
    }
    const expired = license.expiresAt != null && new Date(license.expiresAt).getTime() <= Date.now();
    if (license.status !== "active" || expired) {
        const status = license.status === "active" ? "expired" : license.status;
        throw new LeaseError("license_not_active", 409, "the license is suspended, revoked, or expired", { status });
    }
    return license.maxConcurrent;
}
/**
 * Acquire a floating concurrency seat (FR-001..006/014/022/023/025). Fail-closed on entitlement, live license
 * state, and (optionally) node-lock gating BEFORE any seat work; then the race-safe advisory-lock count+insert
 * + single-use-token replay inside one tenant transaction, with the E004-signed handle minted in the SAME
 * transaction so a signer fault rolls the whole acquire back (503, no seat consumed — SC-021).
 */
export async function acquireLease(deps, tenantId, input) {
    const { pool, repo, config, signer } = deps;
    // --- Phase A: reads only (no seat). Resolve the license + toggles, fail-closed checks, holder-key, gating.
    const prep = await withTenant(pool, tenantId, async (q) => {
        const license = await resolveLicenseForLease(q, { id: input.licenseId, token: input.licenseKey });
        if (!license) {
            const details = input.licenseId !== undefined ? { licenseId: input.licenseId } : undefined;
            throw new LeaseError("license_not_found", 404, "unknown license", details);
        }
        const maxConcurrent = assertEntitledAndActive(license);
        let holderKey;
        try {
            holderKey = deriveHolderKey({ scope: license.scope, reference: input.holderReference, signals: input.signals ?? null }, config.holderKeySalt);
        }
        catch (e) {
            if (e instanceof HolderKeyError)
                throw new LeaseError("validation_error", 400, e.message, { field: e.field });
            throw e;
        }
        return { license, maxConcurrent, holderKey };
    });
    // FR-025: optional "activated-devices-only" gating — resolve a CURRENT activation for the machine (its own
    // read tx). No valid current activation ⇒ fail-closed 409, no seat consumed. Only a RESOLVED activation id
    // is persisted on the lease (the composite FK requires a real activation); an unvalidated client reference
    // is informational and is NOT stored (gating off ⇒ activation_id stays NULL — the two dimensions stay
    // independent, FR-025).
    let resolvedActivationId = null;
    if (prep.license.requireActivation) {
        const ref = input.activationReference ?? null;
        const activation = ref ? await deps.activationRead(pool, tenantId, ref) : null;
        if (!activation || activation.status !== "active" || activation.licenseId !== prep.license.id) {
            throw new LeaseError("activation_required", 409, "a valid current node-lock activation is required", {
                reason: "no_current_activation",
            });
        }
        resolvedActivationId = activation.id;
    }
    const { license, maxConcurrent, holderKey } = prep;
    const timings = license.timings;
    // --- Phase B: the seat transaction. Advisory-lock count+insert (or idempotent replay), then mint the handle
    //     INSIDE the tx so a signer fault rolls back the whole acquire (no seat, no lease — FR-022/SC-021).
    return withTenant(pool, tenantId, async (q) => {
        const outcome = await repo.acquire(q, {
            licenseId: license.id,
            holderKey,
            scope: license.scope,
            nonce: input.acquireToken,
            ttlSeconds: timings.ttlSeconds,
            maxConcurrent,
            overageAllowance: license.overageAllowance,
            activationId: resolvedActivationId,
        });
        if (outcome.kind === "capacity") {
            throw new LeaseError("seat_capacity_exhausted", 409, "the concurrency cap is exhausted", {
                maxConcurrent: outcome.maxConcurrent,
                concurrencyUsed: outcome.concurrencyUsed,
                overageAllowance: outcome.overageAllowance,
            });
        }
        const created = outcome.kind === "created";
        const lease = outcome.lease;
        // Mint + attach the signed handle (default). A signer fault THROWS SignerError → tx rolls back → 503.
        const handle = await maybeSignHandle(q, {
            signer,
            signedHandle: license.signedHandle,
            tenantId,
            productId: license.productId,
            lease,
            handleTtlSeconds: timings.heartbeatSeconds,
        });
        await writeAudit(q, {
            actor: ACTOR,
            action: created ? "lease.acquired" : "lease.reacquired",
            target: lease.id,
            after: { licenseId: lease.licenseId, created, overage: lease.overage },
        });
        // FR-013 (SC-009): meter each fresh OVER-BASE (soft-cap) acquisition to the append-only audit log — the
        // AUTHORITATIVE overage record for later true-up (the lease.overage boolean is only a non-authoritative
        // flag). Captures the concurrency level REACHED and the cap shape; NO card data, NO raw hardware id, NO
        // holder reference (only the license id + the used-vs-cap counts). A replay/re-acquire is never metered.
        if (created && lease.overage) {
            await writeAudit(q, {
                actor: ACTOR,
                action: "lease.overage",
                target: lease.id,
                after: {
                    licenseId: lease.licenseId,
                    concurrencyUsed: outcome.concurrencyUsed,
                    maxConcurrent,
                    overageAllowance: license.overageAllowance,
                },
            });
        }
        return {
            created,
            grant: buildGrant(lease, {
                timings,
                concurrencyUsed: outcome.concurrencyUsed,
                maxConcurrent,
                overageAllowance: license.overageAllowance,
                overage: lease.overage,
                keyId: handle?.keyId ?? null,
                leaseHandle: handle?.leaseHandle ?? null,
            }),
        };
    });
}
/**
 * Mint the E004-signed lease handle for a lease inside the current tx and persist its opaque key id
 * (`handle_key_id`). Returns `null` in plain-authorization mode (no signer configured or the plan toggle off).
 * A signer fault maps to `503 signer_unavailable`, which — thrown inside the caller's tx — rolls the acquire/
 * renew back (no seat consumed on acquire; the lease left unchanged on renew).
 */
export async function maybeSignHandle(q, opts) {
    if (!opts.signedHandle)
        return null;
    if (!opts.signer) {
        throw new LeaseError("signer_unavailable", 503, "the lease handle signer is unavailable");
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    try {
        const signed = await signLeaseHandle(opts.signer, opts.tenantId, opts.productId, {
            leaseId: opts.lease.id,
            licenseId: opts.lease.licenseId,
            holderKey: opts.lease.holderKey,
            scope: opts.lease.scope,
            issuedAtUnix: nowUnix,
            leaseExpiresAtUnix: Math.floor(new Date(opts.lease.expiresAt).getTime() / 1000),
            handleTtlSeconds: opts.handleTtlSeconds,
        });
        await q("UPDATE lease SET handle_key_id = $2, updated_at = now() WHERE id = $1", [opts.lease.id, signed.keyId]);
        return { leaseHandle: signed.leaseHandle, keyId: signed.keyId };
    }
    catch (e) {
        if (e instanceof SignerError) {
            throw new LeaseError("signer_unavailable", 503, `the lease handle signer is unavailable (${e.failure})`);
        }
        throw e;
    }
}
