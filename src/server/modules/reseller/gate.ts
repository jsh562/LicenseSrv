// Reseller subtree-membership gate + scoped descent (E018, FR-002/004/005; AD-001/AD-002, HINT-001/HINT-002).
// THE isolation crux — the single cross-tenant choke point every reseller→sub-tenant ACTION passes through.
//
// The model (data-model.md "isolation crux", INV-2) — NEVER a broadened RLS predicate:
//   1. GATE: `assertSubtreeMembership` asserts the target sub-tenant's `parent_reseller_id` equals the acting
//      reseller's home tenant — a DOWNWARD-ONLY membership check resolved by the repo's privileged filtered
//      lookup. Anything NOT strictly below the reseller (a sibling's customer, a parent, the platform, an
//      IDOR-by-id, or the reseller itself — a reseller has no parent) matches zero rows and resolves to
//      `not_found` (404) with NO existence disclosure — NEVER 403 (403 leaks existence, HINT-002).
//   2. SCOPED DESCENT: `withSubTenantScope` runs the operation under the sub-tenant's OWN `app.current_tenant`
//      (`withTenant`) — but ONLY after the gate passes — so forced RLS checks the write against the
//      sub-tenant's own rows. The op is NEVER run under the reseller's scope, and the per-tenant
//      `tenant_isolation` predicate is NEVER widened to reach across tenants (AD-001, HINT-001).
//
// Performs NO cryptography and holds no secret (presentation-only, Principle I). The dual-identity audit of a
// passed action and the `security_event` audit of a denied escalation are wired at the mutation sites
// (audit.ts / routes.ts, T031/T032); this module is the enforcement choke point they record around.
import type pg from "pg";

import type { TxQuery } from "../../db/client.js";
import { withTenant } from "../../db/client.js";
import { recordResellerSecurityEvent } from "./audit.js";
import { ResellerError } from "./index.js";
import type { ResellerStatus, SubtreeMembershipRepo, SubTenantRow } from "./reseller-repo.js";

/** The pool + membership-repo the gate needs for the scoped descent. */
export interface SubtreeGateDeps {
  pool: pg.Pool;
  repo: SubtreeMembershipRepo;
}

/**
 * Assert the acting reseller OWNS the target sub-tenant (AD-001, FR-002/004). Resolves the sub-tenant through
 * the repo's DOWNWARD-ONLY, ownership-filtered lookup: a match confirms the `parent_reseller_id = reseller`
 * link; ANY non-match — an out-of-subtree sibling/parent/platform reference, an IDOR-by-id, or the reseller's
 * own id (a reseller carries no parent) — fails CLOSED to `not_found` (404) with no existence disclosure,
 * never 403 (HINT-002). On success returns the metadata-only {@link SubTenantRow} so callers avoid a re-read.
 *
 * The caller MUST have already authenticated `resellerTenantId` as the acting principal's own reseller tenant
 * (session tenant == reseller, admin/owner role) — this gate governs the reseller→sub-tenant reach, not the
 * caller's authorization over the reseller itself.
 */
export async function assertSubtreeMembership(
  repo: SubtreeMembershipRepo,
  resellerTenantId: string,
  subTenantId: string,
): Promise<SubTenantRow> {
  const sub = await repo.getSubTenant(resellerTenantId, subTenantId);
  if (!sub) {
    // Downward-only, no disclosure: an out-of-subtree/unknown target is indistinguishable from "not found".
    throw new ResellerError("not_found", 404, "sub-tenant not found");
  }
  return sub;
}

/**
 * The SCOPED DESCENT (AD-001, FR-005): assert subtree membership FIRST, then run `fn` under the sub-tenant's
 * OWN `app.current_tenant` via `withTenant` — so the operation is subject to the sub-tenant's own forced RLS,
 * never the reseller's scope and never a widened predicate. If the gate throws (`not_found`), `fn` is NEVER
 * invoked and no tenant scope is ever entered — the descent is strictly gate-then-act. Returns `fn`'s result.
 */
export async function withSubTenantScope<T>(
  deps: SubtreeGateDeps,
  resellerTenantId: string,
  subTenantId: string,
  fn: (q: TxQuery) => Promise<T>,
): Promise<T> {
  // GATE FIRST — a denial short-circuits before any scope is opened (no descent on an out-of-subtree target).
  await assertSubtreeMembership(deps.repo, resellerTenantId, subTenantId);
  // DESCENT — under the TARGET sub-tenant's own scope (never the reseller's), so RLS checks its own rows.
  return withTenant(deps.pool, subTenantId, fn);
}

// ===================================================================================================================
// T031 [COMPLETES FR-005] — data-access-layer escalation enforcement + security-event audit.
//
// The plain gate above resolves any out-of-subtree reference to `not_found` (404, no disclosure). This layer adds
// the SECOND half of FR-005/SC-007: a denied upward/lateral/IDOR attempt is recorded as a DUAL-IDENTITY
// `security_event` audit row AT THE DATA-ACCESS LAYER — enforced here in the gate, not merely wired ad-hoc at one
// API route, so EVERY caller that descends through the gate (a read, a mutation, any future consumer) records the
// denial uniformly. The recording NEVER broadens the per-tenant RLS predicate: the security event is written under
// the ACTING reseller's OWN `app.current_tenant` scope (the target is not owned — there is no legitimate target
// scope), and the membership resolution itself is the repo's downward-only `parent_reseller_id = :reseller`
// privileged filter (AD-002, HINT-001). A denial is fail-closed: 404 to the caller, `security_event=true` +
// `actor_reseller_id` = the acting reseller in the trail (never 403 — 403 leaks existence, HINT-002).
// ===================================================================================================================

/**
 * The non-disclosing audit context an escalation denial records (FR-005/009). `actorUserId` is the acting
 * reseller-admin principal, `actorResellerId` is its home tenant (the second identity AND the scope the denial is
 * recorded under). `action` defaults to `reseller.subtree.denied`; `attempted` is a non-secret descriptor of the
 * request (a request line) — it must NEVER be used to disclose cross-tenant existence back to the caller.
 */
export interface EscalationAuditContext {
  actorUserId: string;
  actorResellerId: string;
  action?: string;
  attempted?: string | null;
}

/**
 * {@link assertSubtreeMembership} with a data-layer SECURITY-EVENT audit on denial (T031, FR-005). On an
 * out-of-subtree target the underlying gate throws `not_found` (404, no disclosure); this wrapper additionally
 * appends a dual-identity `security_event` row under the acting reseller's OWN scope BEFORE re-throwing, so the
 * denied upward/lateral/IDOR attempt is recorded at the data-access layer regardless of caller. Returns the
 * metadata-only {@link SubTenantRow} on success (the gate passed — no security event).
 */
export async function assertSubtreeMembershipAudited(
  deps: SubtreeGateDeps,
  resellerTenantId: string,
  subTenantId: string,
  audit: EscalationAuditContext,
): Promise<SubTenantRow> {
  try {
    return await assertSubtreeMembership(deps.repo, resellerTenantId, subTenantId);
  } catch (e) {
    if (e instanceof ResellerError && e.code === "not_found") {
      await recordResellerSecurityEvent(deps.pool, {
        scopeTenantId: resellerTenantId,
        actor: audit.actorUserId,
        actorResellerId: audit.actorResellerId,
        action: audit.action ?? "reseller.subtree.denied",
        target: audit.attempted ?? null,
      });
    }
    throw e;
  }
}

/**
 * {@link withSubTenantScope} with a data-layer SECURITY-EVENT audit on denial (T031, FR-005/009). The gate is
 * asserted (recording a dual-identity `security_event` on an out-of-subtree denial) BEFORE the scoped descent, so
 * `fn` runs under the TARGET sub-tenant's OWN `app.current_tenant` ONLY after a passed gate — and a denied
 * escalation is both refused (404) and audited at the data-access layer without ever widening the RLS predicate.
 */
export async function withSubTenantScopeAudited<T>(
  deps: SubtreeGateDeps,
  resellerTenantId: string,
  subTenantId: string,
  audit: EscalationAuditContext,
  fn: (q: TxQuery) => Promise<T>,
): Promise<T> {
  // GATE (audited) FIRST — a denial records a security event and short-circuits before any scope is opened.
  await assertSubtreeMembershipAudited(deps, resellerTenantId, subTenantId, audit);
  // DESCENT — under the TARGET sub-tenant's own scope (never the reseller's), so RLS checks its own rows.
  return withTenant(deps.pool, subTenantId, fn);
}

// ===================================================================================================================
// T039 [COMPLETES FR-011] — the DERIVED read-only suspend cascade (AD-007, HINT-005, SC-009).
//
// A reseller suspension is REVERSIBLE and is NEVER fanned out as a write across its sub-tenants. Instead a
// sub-tenant's read-only state is DERIVED at request time from its managing reseller's `status`: if that reseller
// is `suspended`, a MUTATION on the sub-tenant is refused `409 reseller_suspended` (sign-in + reads stay allowed).
// The derivation reads the reseller's status via the repo (its own-scope read of the `reseller` row + the
// server-derived `parent_reseller_id` link) — never a broadened RLS predicate, never a stored per-sub-tenant flag.
// Reinstating the reseller (flip `status` back to `active`) instantly lifts the cascade with no per-sub-tenant
// write, and already-issued licenses keep verifying offline throughout (this touches no token/crypto, Principle I).
// ===================================================================================================================

/** The minimal reseller-status surface the derived suspend cascade needs (a narrow slice of {@link import("./reseller-repo.js").ResellerRepo}). */
export interface SuspendCascadeRepo {
  getParentResellerId(tenantId: string): Promise<string | null>;
  getReseller(tenantId: string): Promise<{ status: ResellerStatus } | null>;
}

/**
 * Assert a tenant's mutation is not blocked by its managing reseller's suspension (FR-011, AD-007, SC-009). If the
 * tenant is a SUB-TENANT (`parent_reseller_id` set) whose reseller is `suspended`, a mutation is refused
 * `409 reseller_suspended`; a direct-platform tenant (no parent) or a tenant under an active/offboarding reseller
 * is unaffected. DERIVED at request time — no fan-out write, reversible by flipping the reseller status. Reads
 * flow unchanged (callers gate ONLY mutations through this).
 */
export async function assertResellerNotSuspended(repo: SuspendCascadeRepo, tenantId: string): Promise<void> {
  const parentId = await repo.getParentResellerId(tenantId);
  if (!parentId) return; // a direct-platform tenant or a reseller itself carries no managing reseller — no cascade
  const parent = await repo.getReseller(parentId);
  if (parent && parent.status === "suspended") {
    throw new ResellerError("reseller_suspended", 409, "the managing reseller is suspended", {
      resellerId: parentId,
    });
  }
}
