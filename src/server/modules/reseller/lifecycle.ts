// Reseller lifecycle operations (E018). US1 delivers sub-tenant PROVISIONING under the reseller's HARD quota
// (FR-003, [COMPLETES FR-003] via routes T019); later phases (US4) extend this file with onboard
// (create-or-promote) + suspend/reinstate + offboard + operator move, each composing the same repo + gate seams.
//
// provisionSubTenant is the reseller ACTION that CREATES a new tenant UNDER the acting reseller (a downward,
// one-level link). It is quota-gated (over-cap → 409 quota_exceeded) and read-only-cascade-gated (a suspended
// reseller blocks new provisioning → 409 reseller_suspended, AD-007/FR-011 — derived at request time, never a
// fan-out write). The new sub-tenant is created on the audited platform-admin `privileged` seam (the same seam
// E002 uses to provision a tenant), then linked UP via tenant.parent_reseller_id, then a DUAL-IDENTITY
// append-only audit row is written under the NEW sub-tenant's OWN scope (actor = reseller-admin, actor_reseller_id
// = the acting reseller's home tenant, target = the new sub-tenant) so attribution survives a later transfer
// (AD-008, INV-8, FR-009). Performs NO cryptography and holds no secret (presentation-only, Principle I).
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { privileged, withTenant } from "../../db/client.js";
import { provisionTenant } from "../../db/repository.js";
import { provisionFirstAdmin } from "../admin/users.js";
import { writeResellerAudit } from "./audit.js";
import { type BrandingRepo, resolveBranding } from "./branding.js";
import type { ResellerConfig } from "./config.js";
import { ResellerError } from "./index.js";
import type { BrandingFieldName } from "./branding.js";
import type { ResellerRepo, ResellerRow, SubTenantRow } from "./reseller-repo.js";

/** The composed deps a reseller lifecycle action needs — the RLS pool + the shared reseller repo. */
export interface LifecycleDeps {
  pool: pg.Pool;
  repo: ResellerRepo;
}

/** Onboarding also needs the live config (the platform-default sub-tenant quota, FR-003/010). */
export interface OnboardDeps extends LifecycleDeps {
  config: ResellerConfig;
}

/** Provision-a-sub-tenant inputs. `actorUserId` is the acting reseller-admin principal (dual-identity audit). */
export interface ProvisionSubTenantParams {
  /** The acting reseller's HOME tenant id (its own tenant; asserted a reseller by the caller/plane gate). */
  resellerTenantId: string;
  /** The reseller-admin user principal performing the provision (recorded as the audit `actor`). */
  actorUserId: string;
  /** The new sub-tenant's display name (→ `tenant.name`). */
  displayName: string;
  /** The pseudonymous reference to the sub-tenant's first admin (no PII, FR-017); recorded in the audit `after`. */
  firstAdminUserReference: string;
}

/** A URL/DNS-safe slug for a newly-provisioned sub-tenant; the uuid suffix guarantees global uniqueness. */
function subTenantSlug(id: string): string {
  return `st-${id}`;
}

/** A URL/DNS-safe slug for a newly-created reseller tenant; the uuid suffix guarantees global uniqueness. */
function resellerSlug(id: string): string {
  return `rs-${id}`;
}

/**
 * Onboard-a-reseller inputs (FR-001/010) — ONE create-or-select flow discriminated on `mode`:
 *   * `create_new`     — CREATE a brand-new reseller tenant (`displayName` → `tenant.name`).
 *   * `promote_existing` — PROMOTE an existing tenant (`tenantId`) to reseller, subject to the ONE-LEVEL
 *     rule (INV-3): a tenant that is ALREADY a reseller or is ITSELF a sub-tenant cannot be promoted.
 * Both establish the reseller row + its FIRST reseller-admin (owner) + the hard sub-tenant quota
 * (`subTenantQuota`, defaulting to the platform-configured value when omitted/null, FR-003).
 */
export type OnboardResellerParams =
  | {
      mode: "create_new";
      /** The new reseller's display name (→ `tenant.name`). */
      displayName: string;
      /** PSEUDONYMOUS reference to the user to designate as the first reseller-admin (no PII, FR-017). */
      firstAdminUserReference: string;
      /** OPTIONAL hard quota; defaults to `config.defaultSubTenantQuota` when omitted/null (FR-003). */
      subTenantQuota?: number | null;
    }
  | {
      mode: "promote_existing";
      /** The existing tenant to promote to reseller. */
      tenantId: string;
      /** PSEUDONYMOUS reference to the first reseller-admin (no PII, FR-017). */
      firstAdminUserReference: string;
      /** OPTIONAL hard quota; defaults to `config.defaultSubTenantQuota` when omitted/null (FR-003). */
      subTenantQuota?: number | null;
    };

/** The onboarded reseller — its side-table row plus the display name + current sub-tenant count for the wire. */
export interface OnboardedReseller {
  reseller: ResellerRow;
  displayName: string;
  subTenantCount: number;
}

/**
 * Onboard a reseller via ONE create-or-select flow (FR-001/010, US4-AS1). Establishes, in order:
 *   1. the reseller TENANT — created new (`create_new`) on the audited `privileged` seam, or an existing
 *      tenant resolved (`promote_existing`) after enforcing the ONE-LEVEL rule (INV-3): an unknown tenant →
 *      `404 not_found`; a tenant already a reseller → `409 onboarding_conflict` (`already_reseller`); a
 *      tenant that is itself a sub-tenant (carries a `parent_reseller_id`) → `409 onboarding_conflict`
 *      (`already_sub_tenant`).
 *   2. the RESELLER row with the hard sub-tenant quota (supplied or the platform default, FR-003).
 *   3. the FIRST reseller-admin as an OWNER, so the reseller is immediately operable and last-owner
 *      protection applies (FR-010/016, reusing the E006 user-admin surface).
 *   4. an append-only audit row under the reseller's OWN scope (`reseller.onboarded`).
 *
 * Returns the {@link OnboardedReseller} projection. A newly-promoted/created reseller has zero sub-tenants
 * (a plain tenant is referenced by none), so `subTenantCount` is read back for a consistent wire shape.
 */
export async function onboardReseller(
  deps: OnboardDeps,
  params: OnboardResellerParams,
  actorUserId: string,
): Promise<OnboardedReseller> {
  const quota = params.subTenantQuota ?? deps.config.defaultSubTenantQuota;

  let tenantId: string;
  let displayName: string;

  if (params.mode === "create_new") {
    tenantId = randomUUID();
    displayName = params.displayName;
    // Create the reseller tenant on the audited platform-admin seam (E002 tenant provisioning).
    await provisionTenant(deps.pool, { id: tenantId, slug: resellerSlug(tenantId), name: displayName });
  } else {
    tenantId = params.tenantId;
    // Resolve the existing tenant (existence + display name) on the privileged seam — a metadata read.
    const meta = await privileged(deps.pool, async (q) => {
      const r = await q("SELECT id, name FROM tenant WHERE id = $1 AND deleted_at IS NULL", [tenantId]);
      return r.rowCount ? (r.rows[0] as { id: string; name: string | null }) : null;
    });
    if (!meta) {
      throw new ResellerError("not_found", 404, "tenant not found", { tenantId });
    }
    // ONE-LEVEL rule (INV-3): a tenant cannot be both a reseller and a sub-tenant, nor a reseller twice.
    const already = await deps.repo.getReseller(tenantId);
    if (already) {
      throw new ResellerError("onboarding_conflict", 409, "tenant is already a reseller", {
        tenantId,
        reason: "already_reseller",
      });
    }
    const parent = await deps.repo.getParentResellerId(tenantId);
    if (parent) {
      throw new ResellerError("onboarding_conflict", 409, "tenant is already a sub-tenant", {
        tenantId,
        reason: "already_sub_tenant",
      });
    }
    displayName = meta.name ?? "";
  }

  // Establish the reseller row (hard quota) under its own scope, then its first reseller-admin (owner).
  const reseller = await deps.repo.createReseller(tenantId, { subTenantQuota: quota });
  await provisionFirstAdmin(deps.pool, tenantId, actorUserId, params.firstAdminUserReference);

  // Append-only onboarding audit under the reseller's OWN scope (operator action; no acting reseller).
  await withTenant(deps.pool, tenantId, (q) =>
    writeAudit(q, {
      actor: actorUserId,
      action: "reseller.onboarded",
      target: tenantId,
      after: {
        mode: params.mode,
        subTenantQuota: quota,
        firstAdminUserReference: params.firstAdminUserReference,
      },
    }),
  );

  const subTenantCount = await deps.repo.countSubTenants(tenantId);
  return { reseller, displayName, subTenantCount };
}

/**
 * Provision a NEW sub-tenant under the acting reseller, subject to its HARD sub-tenant quota (FR-003, US1-AS3).
 *
 * Order of operations (fail-fast, isolation-safe):
 *   1. Load the acting reseller row (its own scope). Not a reseller → `not_found` (the plane gate normally
 *      catches this first; kept fail-closed here so the lifecycle is safe to call directly).
 *   2. A `suspended` reseller cannot provision (derived read-only cascade, AD-007) → `409 reseller_suspended`.
 *   3. Count the reseller's LIVE sub-tenants; at/over the hard cap → `409 quota_exceeded` (`details` carry the
 *      quota + used position). The count is taken BEFORE creation so the cap is inclusive.
 *   4. Create the new tenant on the audited `privileged` seam, link it UP to the reseller, and write ONE
 *      dual-identity append-only audit row under the NEW sub-tenant's scope (actor + actor_reseller_id + target).
 *
 * Returns the METADATA-ONLY {@link SubTenantRow} of the created sub-tenant (FR-017 — no license/usage/activation).
 */
export async function provisionSubTenant(
  deps: LifecycleDeps,
  params: ProvisionSubTenantParams,
): Promise<SubTenantRow> {
  const reseller = await deps.repo.getReseller(params.resellerTenantId);
  if (!reseller) {
    throw new ResellerError("not_found", 404, "reseller not found");
  }
  if (reseller.status === "suspended") {
    throw new ResellerError("reseller_suspended", 409, "reseller is suspended", {
      resellerId: params.resellerTenantId,
    });
  }

  const used = await deps.repo.countSubTenants(params.resellerTenantId);
  if (used >= reseller.subTenantQuota) {
    throw new ResellerError("quota_exceeded", 409, "sub-tenant quota exceeded", {
      quota: reseller.subTenantQuota,
      used,
    });
  }

  const id = randomUUID();
  // Create the sub-tenant on the audited platform-admin seam (E002 tenant provisioning), then link it UP.
  await provisionTenant(deps.pool, { id, slug: subTenantSlug(id), name: params.displayName });
  await deps.repo.setParentReseller(id, params.resellerTenantId);

  // Dual-identity, append-only audit under the NEW sub-tenant's OWN scope (AD-008, INV-8, FR-009).
  await withTenant(deps.pool, id, (q) =>
    writeResellerAudit(q, {
      actor: params.actorUserId,
      action: "sub_tenant.provision",
      actorResellerId: params.resellerTenantId,
      target: id,
      after: { displayName: params.displayName, firstAdminUserReference: params.firstAdminUserReference },
    }),
  );

  const row = await deps.repo.getSubTenant(params.resellerTenantId, id);
  if (!row) {
    // Should never happen (we just created + linked it); fail closed rather than return a partial shape.
    throw new ResellerError("not_found", 404, "sub-tenant not found");
  }
  return row;
}

// ===================================================================================================================
// T039 [COMPLETES FR-011] — suspend / reinstate (reversible; the read-only cascade is DERIVED, see gate.ts).
//
// SUSPEND is an OPERATOR lifecycle transition on the `reseller` row ONLY — it flips `status active → suspended`
// and writes ONE audit row under the reseller's OWN scope. It NEVER fans a write out across the reseller's
// sub-tenants: a sub-tenant's read-only state is derived at request time from this status (AD-007,
// `gate.assertResellerNotSuspended`). REINSTATE reverses it (`suspended → active`), instantly lifting the cascade
// with no per-sub-tenant write. Already-issued licenses keep verifying offline throughout (no token/crypto touched,
// Principle I). An out-of-state transition (suspend a non-active reseller / reinstate a non-suspended one) is
// refused `409 invalid_state_transition` fail-closed (SC-009).
// ===================================================================================================================

/**
 * Suspend a reseller (FR-011, SC-009) — reversible; blocks new reseller activity and DERIVES a read-only cascade to
 * its sub-tenants (no fan-out write). Only an `active` reseller can be suspended (else `409 invalid_state_transition`);
 * an unknown reseller → `404 not_found`. Audited under the reseller's own scope. Returns the updated {@link ResellerRow}.
 */
export async function suspendReseller(
  deps: LifecycleDeps,
  resellerTenantId: string,
  actorUserId: string,
): Promise<ResellerRow> {
  const reseller = await deps.repo.getReseller(resellerTenantId);
  if (!reseller) {
    throw new ResellerError("not_found", 404, "reseller not found", { resellerId: resellerTenantId });
  }
  if (reseller.status !== "active") {
    throw new ResellerError("invalid_state_transition", 409, "only an active reseller can be suspended", {
      from: reseller.status,
      to: "suspended",
    });
  }
  const updated = await deps.repo.setStatus(resellerTenantId, "suspended");
  if (!updated) {
    throw new ResellerError("not_found", 404, "reseller not found", { resellerId: resellerTenantId });
  }
  await withTenant(deps.pool, resellerTenantId, (q) =>
    writeAudit(q, {
      actor: actorUserId,
      action: "reseller.suspended",
      target: resellerTenantId,
      before: { status: reseller.status },
      after: { status: "suspended" },
    }),
  );
  return updated;
}

/**
 * Reinstate a SUSPENDED reseller (FR-011, SC-009) — restores normal access and lifts the derived read-only cascade
 * from its sub-tenants. Only a `suspended` reseller can be reinstated (an `active` or terminal `offboarding` reseller
 * → `409 invalid_state_transition`); an unknown reseller → `404 not_found`. Audited. Returns the updated row.
 */
export async function reinstateReseller(
  deps: LifecycleDeps,
  resellerTenantId: string,
  actorUserId: string,
): Promise<ResellerRow> {
  const reseller = await deps.repo.getReseller(resellerTenantId);
  if (!reseller) {
    throw new ResellerError("not_found", 404, "reseller not found", { resellerId: resellerTenantId });
  }
  if (reseller.status !== "suspended") {
    throw new ResellerError("invalid_state_transition", 409, "only a suspended reseller can be reinstated", {
      from: reseller.status,
      to: "active",
    });
  }
  const updated = await deps.repo.setStatus(resellerTenantId, "active");
  if (!updated) {
    throw new ResellerError("not_found", 404, "reseller not found", { resellerId: resellerTenantId });
  }
  await withTenant(deps.pool, resellerTenantId, (q) =>
    writeAudit(q, {
      actor: actorUserId,
      action: "reseller.reinstated",
      target: resellerTenantId,
      before: { status: reseller.status },
      after: { status: "active" },
    }),
  );
  return updated;
}

// ===================================================================================================================
// T040 [COMPLETES FR-012] — offboard: transfer-or-reassign every sub-tenant (no orphans) + notice/grace window.
//
// Offboarding is a ONE-WAY, TERMINAL path. It transitions `active → offboarding`, stamping a STABLE grace anchor
// (`reseller.offboarding_started_at`, set once via the repo's COALESCE) so `graceEndsAt = offboarding_started_at +
// config.offboardingGraceSecs` is stable across re-invocations (IDEMPOTENT PROGRESS). Offboard is BLOCKED
// (`409 sub_tenants_unresolved`, carrying the live unresolved count + graceEndsAt) until EVERY sub-tenant has been
// transferred to another reseller or reassigned to direct-platform (via the operator move) — no sub-tenant is ever
// orphaned. Each attempt is audited. Once the count reaches 0 the offboard COMPLETES (`200`, status `offboarding`,
// unresolvedSubTenantCount 0). A suspended reseller cannot be offboarded directly → `409 invalid_state_transition`.
// ===================================================================================================================

/** The outcome of an offboard attempt (contract `OffboardResult`) — status + live unresolved count + grace window. */
export interface OffboardOutcome {
  reseller: ResellerRow;
  unresolvedSubTenantCount: number;
  graceEndsAt: Date;
}

/**
 * Begin/continue offboarding a reseller (FR-012, SC-010). Transitions it to `offboarding` (stable grace anchor),
 * then requires every sub-tenant resolved: while any remain it is refused `409 sub_tenants_unresolved` (details
 * carry `unresolvedSubTenantCount` + `graceEndsAt`); with none left it completes (`OffboardOutcome`, count 0).
 * IDEMPOTENT — re-invoking on an already-`offboarding` reseller keeps the original anchor and re-reports progress.
 * A `suspended` reseller cannot offboard → `409 invalid_state_transition`; an unknown reseller → `404 not_found`.
 * Audited under the reseller's own scope on every attempt.
 */
export async function offboardReseller(
  deps: OnboardDeps,
  resellerTenantId: string,
  actorUserId: string,
): Promise<OffboardOutcome> {
  const reseller = await deps.repo.getReseller(resellerTenantId);
  if (!reseller) {
    throw new ResellerError("not_found", 404, "reseller not found", { resellerId: resellerTenantId });
  }
  if (reseller.status !== "active" && reseller.status !== "offboarding") {
    // A suspended reseller must be reinstated (or handled) before offboarding — offboarding starts from active.
    throw new ResellerError("invalid_state_transition", 409, "the reseller cannot be offboarded from its current state", {
      from: reseller.status,
      to: "offboarding",
    });
  }
  const updated = await deps.repo.setStatus(resellerTenantId, "offboarding");
  if (!updated || !updated.offboardingStartedAt) {
    throw new ResellerError("not_found", 404, "reseller not found", { resellerId: resellerTenantId });
  }
  const graceEndsAt = new Date(updated.offboardingStartedAt.getTime() + deps.config.offboardingGraceSecs * 1000);
  const count = await deps.repo.countSubTenants(resellerTenantId);

  await withTenant(deps.pool, resellerTenantId, (q) =>
    writeAudit(q, {
      actor: actorUserId,
      action: "reseller.offboarding",
      target: resellerTenantId,
      after: { unresolvedSubTenantCount: count, graceEndsAt: graceEndsAt.toISOString() },
    }),
  );

  if (count > 0) {
    throw new ResellerError("sub_tenants_unresolved", 409, "resolve all sub-tenants before offboarding this reseller", {
      unresolvedSubTenantCount: count,
      graceEndsAt: graceEndsAt.toISOString(),
    });
  }
  return { reseller: updated, unresolvedSubTenantCount: 0, graceEndsAt };
}

// ===================================================================================================================
// T041 [COMPLETES FR-015] — operator-only MOVE: re-point parent, PRESERVE overrides, RE-RESOLVE locks, dual audit.
//
// The move re-points `tenant.parent_reseller_id` (to another reseller, or NULL for direct-platform) on the audited
// privileged seam. It PRESERVES the sub-tenant's own `branding_profile` overrides (that row is never touched) while
// per-field LOCKS re-resolve to the DESTINATION reseller — resolution is computed at read (AD-004), so the new lock
// set naturally takes effect on the next branding read; the move re-resolves it here for the audit's branding-context
// record. It writes a DUAL-IDENTITY audit on BOTH the source and the destination (each carrying its own
// `actor_reseller_id`) under the sub-tenant (target) scope (AD-008, SC-014). Guards: unknown sub-tenant/destination
// → 404; a suspended source or destination → `409 reseller_suspended`; an offboarding destination →
// `409 invalid_state_transition`; the destination at its hard quota → `409 quota_exceeded`.
// ===================================================================================================================

/** A move destination (contract `MoveSubTenantRequest.destination`) — another reseller, or direct-platform (no reseller). */
export type MoveDestination =
  | { type: "to_reseller"; destinationResellerId: string }
  | { type: "to_direct_platform" };

/** The dependencies an operator move needs — the RLS pool + repo, the branding repo (lock re-resolution), and config. */
export interface MoveDeps extends LifecycleDeps {
  branding: BrandingRepo;
  config: ResellerConfig;
}

/** The result of an operator move — the re-parented sub-tenant + the source/destination reseller ids (dual identity). */
export interface MovedSubTenant {
  subTenant: SubTenantRow;
  sourceResellerId: string | null;
  destinationResellerId: string | null;
}

/**
 * Operator-only move of a sub-tenant between resellers or to/from direct-platform (FR-015, SC-014). Re-points the
 * parent link, preserves the sub-tenant's own overrides, re-resolves per-field locks against the destination, and
 * writes a dual-identity audit on BOTH sides. See the block comment above for the full guard set. Returns the
 * re-parented {@link MovedSubTenant}.
 */
export async function moveSubTenant(
  deps: MoveDeps,
  params: { subTenantId: string; destination: MoveDestination; actorUserId: string },
): Promise<MovedSubTenant> {
  const { subTenantId, destination, actorUserId } = params;

  // Existence (privileged metadata read; a tombstoned/unknown tenant → 404, no disclosure).
  const meta = await privileged(deps.pool, async (q) => {
    const r = await q(
      "SELECT id, slug, name, parent_reseller_id, deleted_at, created_at FROM tenant WHERE id = $1 AND deleted_at IS NULL",
      [subTenantId],
    );
    return r.rowCount
      ? (r.rows[0] as {
          id: string;
          slug: string;
          name: string | null;
          parent_reseller_id: string | null;
          deleted_at: Date | null;
          created_at: Date;
        })
      : null;
  });
  if (!meta) {
    throw new ResellerError("not_found", 404, "sub-tenant not found", { subTenantId });
  }
  const sourceResellerId = meta.parent_reseller_id;

  // A suspended SOURCE reseller blocks the move (moves are blocked while suspended, contract MoveConflict).
  if (sourceResellerId) {
    const src = await deps.repo.getReseller(sourceResellerId);
    if (src && src.status === "suspended") {
      throw new ResellerError("reseller_suspended", 409, "the source reseller is suspended", {
        resellerId: sourceResellerId,
      });
    }
  }

  let destinationResellerId: string | null = null;
  if (destination.type === "to_reseller") {
    destinationResellerId = destination.destinationResellerId;
    const dest = await deps.repo.getReseller(destinationResellerId);
    if (!dest) {
      throw new ResellerError("not_found", 404, "destination reseller not found", { resellerId: destinationResellerId });
    }
    if (dest.status === "suspended") {
      throw new ResellerError("reseller_suspended", 409, "the destination reseller is suspended", {
        resellerId: destinationResellerId,
      });
    }
    if (dest.status === "offboarding") {
      throw new ResellerError("invalid_state_transition", 409, "the destination reseller is offboarding", {
        resellerId: destinationResellerId,
        from: "offboarding",
        to: "active",
      });
    }
    // Hard-quota gate (skipped for a no-op move to the same reseller). At/over the cap → 409 quota_exceeded.
    if (destinationResellerId !== sourceResellerId) {
      const used = await deps.repo.countSubTenants(destinationResellerId);
      if (used >= dest.subTenantQuota) {
        throw new ResellerError("quota_exceeded", 409, "the destination reseller is at its sub-tenant quota", {
          quota: dest.subTenantQuota,
          used,
        });
      }
    }
  }

  // Re-point the parent link (privileged, cross-tenant operator write — never a broadened predicate).
  if (destinationResellerId) {
    await deps.repo.setParentReseller(subTenantId, destinationResellerId);
  } else {
    await deps.repo.clearParentReseller(subTenantId);
  }

  // RE-RESOLVE per-field locks against the DESTINATION reseller (overrides preserved — the sub-tenant profile is
  // untouched). Resolution is computed at read; this snapshot backs the audit's branding-context record (SC-014).
  const ownProfile = await deps.branding.getProfilePrivileged(subTenantId);
  const destLayer = destinationResellerId ? await deps.branding.getProfilePrivileged(destinationResellerId) : null;
  const resolved = resolveBranding({
    subTenant: ownProfile ?? { fields: {}, lockedFields: [] },
    reseller: destLayer,
    platform: deps.config.platformBranding,
  });
  const lockedAtDestination: BrandingFieldName[] = resolved.filter((f) => f.locked).map((f) => f.field);

  // DUAL-IDENTITY audit on BOTH source and destination, under the sub-tenant (target) scope (AD-008, SC-014).
  await withTenant(deps.pool, subTenantId, async (q) => {
    if (sourceResellerId) {
      await writeResellerAudit(q, {
        actor: actorUserId,
        action: "sub_tenant.move.source",
        actorResellerId: sourceResellerId,
        target: subTenantId,
        before: { resellerId: sourceResellerId },
        after: { resellerId: destinationResellerId },
      });
    }
    if (destinationResellerId) {
      await writeResellerAudit(q, {
        actor: actorUserId,
        action: "sub_tenant.move.destination",
        actorResellerId: destinationResellerId,
        target: subTenantId,
        before: { resellerId: sourceResellerId },
        after: { resellerId: destinationResellerId, lockedFields: lockedAtDestination },
      });
    }
    if (!sourceResellerId && !destinationResellerId) {
      // Direct-platform → direct-platform (no reseller either side): a plain, non-delegated move audit.
      await writeAudit(q, { actor: actorUserId, action: "sub_tenant.moved", target: subTenantId });
    }
  });

  const subTenant: SubTenantRow = {
    id: meta.id,
    slug: meta.slug,
    name: meta.name,
    parentResellerId: destinationResellerId,
    deletedAt: meta.deleted_at,
    createdAt: meta.created_at,
  };
  return { subTenant, sourceResellerId, destinationResellerId };
}
