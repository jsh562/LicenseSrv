// Lease heartbeat-renew service (E015, FR-007/011/022/024; ADR-0012 AD-003). Extends a live lease's expiry to
// a SERVER-computed `now + ttl` idempotently (repeated heartbeats keep exactly one seat, SC-005), guarded by
// the generation fence + `status='live' AND expires_at>now()` predicate so a stale/late renew after a reclaim
// or expiry matches 0 rows and is refused `409 lease_not_renewable` (FR-011). Renew RE-CHECKS live license
// state, so a renew against a now-revoked license is refused (FR-024). The refreshed E004-signed handle is
// minted inside the SAME transaction, so a signer fault leaves the lease and its seat UNCHANGED (503, SC-021).
// [COMPLETES FR-007, FR-011, FR-022]
import { writeAudit } from "../../audit/index.js";
import { withTenant } from "../../db/client.js";
import { type LeaseGrant, buildGrant, maybeSignHandle, resolveLicenseForLease } from "./acquire.js";
import { type LeaseDeps, LeaseError } from "./index.js";

const ACTOR = "lease-api";

/** The renew outcome — a fresh {@link LeaseGrant} at the extended expiry (HTTP 200). */
export interface RenewResult {
  grant: LeaseGrant;
}

type RenewReason = "reclaimed" | "expired" | "fenced" | "license_revoked";

/**
 * Renew (heartbeat) a live lease. `404 not_found` for an unknown/cross-tenant lease (FR-019). Re-checks the
 * live license state and refuses a REVOKED license with `409 lease_not_renewable {reason:'license_revoked'}`
 * (FR-024). The fence-guarded UPDATE extends the expiry and bumps the generation; a stale/late renew after a
 * reclaim/expiry matches 0 rows → `409 lease_not_renewable` with the diagnosed reason (FR-011). A signer fault
 * while signed-handle mode is on rolls the renew back → `503 signer_unavailable`, lease unchanged (SC-021).
 */
export async function renewLease(deps: LeaseDeps, tenantId: string, leaseId: string): Promise<RenewResult> {
  const { pool, repo, signer } = deps;

  return withTenant(pool, tenantId, async (q): Promise<RenewResult> => {
    const existing = await repo.getById(q, leaseId);
    if (!existing) throw new LeaseError("not_found", 404, "unknown lease", { leaseId });

    const license = await resolveLicenseForLease(q, { id: existing.licenseId });
    // The composite FK guarantees the license exists; treat a missing row defensively as non-renewable.
    if (!license || license.status === "revoked") {
      throw notRenewable("license_revoked");
    }

    const renewed = await repo.renew(q, { leaseId, ttlSeconds: license.timings.ttlSeconds });
    if (!renewed) {
      throw notRenewable(diagnose(existing.status, existing.expiresAt));
    }

    // Refresh the signed handle (default) inside the SAME tx — a signer fault rolls the renew back (SC-021).
    const handle = await maybeSignHandle(q, {
      signer,
      signedHandle: license.signedHandle,
      tenantId,
      productId: license.productId,
      lease: renewed,
      handleTtlSeconds: license.timings.heartbeatSeconds,
    });

    const concurrencyUsed = await repo.countLive(q, license.id);
    await writeAudit(q, {
      actor: ACTOR,
      action: "lease.renewed",
      target: renewed.id,
      after: { licenseId: renewed.licenseId },
    });

    return {
      grant: buildGrant(renewed, {
        timings: license.timings,
        concurrencyUsed,
        maxConcurrent: license.maxConcurrent ?? 0,
        overageAllowance: license.overageAllowance,
        overage: false, // a renew never consumes an over-base seat (contract: always false on renew)
        keyId: handle?.keyId ?? null,
        leaseHandle: handle?.leaseHandle ?? null,
      }),
    };
  });
}

function notRenewable(reason: RenewReason): LeaseError {
  return new LeaseError("lease_not_renewable", 409, "the lease can no longer be renewed; re-acquire", { reason });
}

/** Diagnose WHY a fence-guarded renew matched 0 rows, from the lease's pre-renew state (FR-011). */
function diagnose(status: string, expiresAt: string): RenewReason {
  if (status !== "live") return "reclaimed"; // released or reclaimed — a terminal seat
  if (new Date(expiresAt).getTime() <= Date.now()) return "expired";
  return "fenced";
}
