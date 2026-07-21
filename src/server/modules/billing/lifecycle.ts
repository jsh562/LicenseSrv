// Billing lifecycle apply-actions (FR-005/006/007/009/011/012/013; AD-003, HINT-002/003). These are the
// side-effect functions the webhook orchestrator (webhook.ts) calls AFTER it has verified the signature and
// deduped the event — each runs INSIDE the orchestrator's single tenant transaction `q`, so the E008 license
// side effect, the subscription overlay advance, and the idempotency-claim ledger row all commit atomically
// (true exactly-once, HINT-002). E014 DRIVES the E008 lifecycle (issue/reinstate) and refreshes the license
// snapshot — it never re-implements the transitions and never mutates the `license.status` enum: grace is a
// pure OVERLAY on `subscription.billing_state` (HINT-003). The webhook actor is SYNTHETIC (the provider
// webhook, not a human admin) and every mutation is audited with the triggering `provider_event_id` (FR-013).
import { randomUUID } from "node:crypto";

import { writeAudit } from "../../audit/index.js";
import type { TxQuery } from "../../db/client.js";
import { toEntitlementMap } from "../issuance/claims.js";
import { issueLicense } from "../issuance/licenses.js";
import { reinstateLicense, revokeLicense } from "../issuance/lifecycle.js";
import { resolveGraceSeconds } from "./config.js";
import type { CanonicalEvent } from "./events.js";
import type { BillingDeps } from "./index.js";
import { BillingError } from "./index.js";
import type { ResolvedConnection } from "./connection-repo.js";
import { applySubscriptionState, linkSubscription, resolveSubscriptionByExternalId, type SubscriptionRecord } from "./subscription-repo.js";

/** The synthetic actor recorded on every webhook-driven billing mutation (FR-013 — not a human admin). */
export const WEBHOOK_ACTOR = "billing-webhook";

/** The synthetic system actor recorded on a reconciliation-driven correction (FR-013 — no provider event id). */
export const RECONCILE_ACTOR = "billing-reconcile-worker";

/**
 * The audit attribution + actor override threaded through an apply-action (FR-013). The WEBHOOK path leaves
 * it empty → the mutation is attributed to {@link WEBHOOK_ACTOR} with the triggering `provider_event_id`. The
 * time-driven RECONCILE path (reconcile-worker.ts) supplies a SYNTHETIC system actor + a provider-event-id-
 * free triggering source (the subscription id + the reconciliation job/snapshot ref) so a correction with no
 * provider event id is still fully attributable.
 */
export interface MutationContext {
  /** The actor recorded on the mutation's audit + any E008 transition; default {@link WEBHOOK_ACTOR}. */
  actor?: string;
  /** The audit `after` triggering source; default `{ providerEventId }`. Reconcile passes `{ subscriptionId, reconcileJobId }`. */
  source?: Record<string, unknown>;
}

/** The audit triggering-source: the reconcile-supplied synthetic source, else the webhook's `provider_event_id`. */
function auditSource(ctx: MutationContext, event: CanonicalEvent): Record<string, unknown> {
  return ctx.source ?? { providerEventId: event.providerEventId };
}

/** The result of a provision attempt (webhook.ts records the ledger claim from the `subscriptionId`). */
export interface ProvisionResult {
  /** True when a license was provisioned/reused and linked; false when the event was unmapped (→ dead-letter). */
  applied: boolean;
  /** The resolved/created subscription id (present when applied). */
  subscriptionId: string | null;
  /** The E008 license id (present when applied). */
  licenseId: string | null;
  /** The dead-letter reason when `!applied` (e.g. `unmapped_event`). */
  reason: string | null;
  /** True when the create raced a concurrent create and lost the 1:1 link UNIQUE → an idempotent duplicate. */
  duplicate?: boolean;
}

/**
 * Resolve (or create) the pseudonymous E008 customer a provisioned license is issued under, keyed on the
 * provider customer id (FR-005). The ref is `billing:<provider>:<externalCustomerId>` — a stable pseudonymous
 * label (NOT PII/card data, FR-018), upserted on the tenant's `UNIQUE (tenant_id, ref)`. Returns null when
 * the event carries no customer id (→ the provision dead-letters). Runs in the caller's tenant tx.
 */
async function resolveCustomer(q: TxQuery, provider: string, externalCustomerId: string | null | undefined): Promise<string | null> {
  if (!externalCustomerId) return null;
  const ref = `billing:${provider}:${externalCustomerId}`;
  const r = await q(
    `INSERT INTO customer (id, tenant_id, ref)
     VALUES ($1, current_setting('app.current_tenant')::uuid, $2)
     ON CONFLICT (tenant_id, ref) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [randomUUID(), ref],
  );
  return r.rowCount ? (r.rows[0] as { id: string }).id : null;
}

/**
 * Provision on a subscription-created/activated event (FR-005/012). Issues a NEW license via the E008
 * issuance path (in the shared tx `q`) and links it 1:1 to the subscription (`license_id` set ONCE), OR
 * resolves to the already-linked subscription when one exists (idempotent re-creation). An unmapped
 * plan/customer/subscription returns `{ applied: false, reason: 'unmapped_event' }` → dead-letter. A
 * concurrent create that loses the 1:1 UNIQUE returns `{ duplicate: true }`. Audited with the event id.
 */
export async function applyProvision(
  deps: BillingDeps,
  q: TxQuery,
  tenantId: string,
  conn: ResolvedConnection,
  event: CanonicalEvent,
  existing: SubscriptionRecord | null,
): Promise<ProvisionResult> {
  // Idempotent re-creation: a create event for an already-linked subscription reuses the existing license.
  // Revoked-not-resurrected (FR-010): a late/duplicate create for a subscription whose license was already
  // revoked (refund/chargeback) is a benign no-op — the terminal license status is never changed here.
  if (existing) {
    const lic = await q("SELECT status FROM license WHERE id = $1", [existing.licenseId]);
    const revoked = Boolean(lic.rowCount) && (lic.rows[0] as { status: string }).status === "revoked";
    await writeAudit(q, {
      actor: WEBHOOK_ACTOR,
      action: "billing.provisioned",
      target: existing.licenseId,
      after: { providerEventId: event.providerEventId, subscriptionId: existing.id, reused: true, ...(revoked ? { revoked: true } : {}) },
    });
    return { applied: true, subscriptionId: existing.id, licenseId: existing.licenseId, reason: null };
  }

  const extId = event.externalSubscriptionId;
  const mapping = event.planKey ? conn.planMap[event.planKey] : undefined;
  if (!extId || !mapping) return { applied: false, subscriptionId: null, licenseId: null, reason: "unmapped_event" };

  if (!deps.signer) throw new BillingError("signer_unavailable", 503, "no signer is configured for provisioning");

  const customerId = await resolveCustomer(q, conn.provider, event.externalCustomerId);
  if (!customerId) return { applied: false, subscriptionId: null, licenseId: null, reason: "unmapped_event" };

  const license = await issueLicense(
    deps.pool,
    deps.signer,
    tenantId,
    WEBHOOK_ACTOR,
    {
      planId: mapping.planId,
      customerId,
      expiresAt: event.periodEndUnix != null ? new Date(event.periodEndUnix * 1000).toISOString() : null,
    },
    q,
  );

  let created: SubscriptionRecord;
  try {
    created = await linkSubscription(q, {
      provider: conn.provider,
      externalSubscriptionId: extId,
      licenseId: license.id,
      billingState: "active",
      occurredAt: event.occurredAt,
    });
  } catch (e) {
    // A concurrent create of the same subscription lost the 1:1/external-id UNIQUE → idempotent duplicate.
    if (e instanceof BillingError && e.code === "duplicate_subscription") {
      return { applied: false, subscriptionId: null, licenseId: null, reason: null, duplicate: true };
    }
    throw e;
  }

  await writeAudit(q, {
    actor: WEBHOOK_ACTOR,
    action: "billing.provisioned",
    target: license.id,
    after: { providerEventId: event.providerEventId, subscriptionId: created.id, planId: mapping.planId },
  });
  return { applied: true, subscriptionId: created.id, licenseId: license.id, reason: null };
}

/** Load a license's status + plan under a row lock (serializes concurrent per-license billing changes). */
async function lockLicense(q: TxQuery, licenseId: string): Promise<{ status: string; planId: string }> {
  const r = await q("SELECT status, plan_id FROM license WHERE id = $1 FOR UPDATE", [licenseId]);
  if (!r.rowCount) throw new BillingError("license_not_found", 404, "the linked license no longer exists");
  const row = r.rows[0] as { status: string; plan_id: string };
  return { status: row.status, planId: row.plan_id };
}

/**
 * Apply a renewal / successful-payment / reactivation (the `renew` action; FR-006/009/013). Refined here
 * against the current state: when the linked license is `suspended` (grace elapsed → auto-suspended) it is
 * REINSTATED via the E008 service (recovery, FR-009); the license snapshot is refreshed from the CURRENT
 * E007 effective entitlements and its term extended to the event's period end (FR-006 — re-reads current
 * entitlements, extends term, keeps active); the subscription overlay clears to `active` (grace cleared).
 * A `revoked` license is terminal and never resurrected (FR-010). Audited with the event id.
 */
export async function applyRenew(
  deps: BillingDeps,
  q: TxQuery,
  tenantId: string,
  sub: SubscriptionRecord,
  event: CanonicalEvent,
  ctx: MutationContext = {},
): Promise<void> {
  const actor = ctx.actor ?? WEBHOOK_ACTOR;
  const lic = await lockLicense(q, sub.licenseId);
  if (lic.status === "revoked") return; // terminal — never resurrected (FR-010)

  if (lic.status === "suspended") {
    await reinstateLicense(deps.pool, tenantId, actor, sub.licenseId, q); // E008 recovery (FR-009)
  }

  // FR-006: re-read the CURRENT effective plan definition (entitlements may have changed since issuance) and
  // refresh the license snapshot; extend the term to the event's period end when the event carries one.
  const eff = await deps.effective(deps.pool, tenantId, lic.planId);
  if (eff) {
    const entMap = toEntitlementMap(eff.entitlements);
    await q(
      `UPDATE license
          SET entitlements = $2::jsonb,
              max_activations = $3,
              expires_at = CASE WHEN $4::double precision IS NULL THEN expires_at ELSE to_timestamp($4) END,
              updated_at = now()
        WHERE id = $1`,
      [sub.licenseId, JSON.stringify(entMap), eff.maxActivations, event.periodEndUnix ?? null],
    );
  }

  await applySubscriptionState(q, sub.id, { billingState: "active", graceExpiresAt: null, occurredAt: event.occurredAt });
  await writeAudit(q, {
    actor,
    action: "billing.renewed",
    target: sub.licenseId,
    after: { ...auditSource(ctx, event), billingState: "active", extendedTo: event.periodEndUnix ?? null },
  });
}

/**
 * Apply a cancellation or payment-failure (the `cancel` / `past_due` actions; FR-007/011/013). Moves the
 * subscription into a bounded grace window (`billing_state` → `grace` / `past_due`, `grace_expires_at` =
 * now + the resolved per-plan grace) — the LICENSE STAYS ACTIVE (usable); NO immediate suspend. Auto-suspend
 * is the TIME-driven grace worker's job (FR-008, HINT-003). Audited with the event id.
 */
export async function applyGrace(
  deps: BillingDeps,
  q: TxQuery,
  _tenantId: string,
  conn: ResolvedConnection,
  sub: SubscriptionRecord,
  event: CanonicalEvent,
  action: "cancel" | "past_due",
  now: Date = new Date(),
  ctx: MutationContext = {},
): Promise<void> {
  // Revoked-not-resurrected (FR-010): a cancel/payment-failure on an already-revoked license is a no-op —
  // a terminal license never re-enters a grace overlay.
  const lic = await lockLicense(q, sub.licenseId);
  if (lic.status === "revoked") return;

  const graceSeconds = resolveGraceSeconds(
    deps.config,
    { defaultGraceSeconds: conn.defaultGraceSeconds, graceOverrides: conn.graceOverrides },
    event.planKey,
  );
  const graceExpiresAt = new Date(now.getTime() + graceSeconds * 1000);
  const billingState = action === "cancel" ? "grace" : "past_due";

  await applySubscriptionState(q, sub.id, { billingState, graceExpiresAt, occurredAt: event.occurredAt });
  await writeAudit(q, {
    actor: ctx.actor ?? WEBHOOK_ACTOR,
    action: "billing.grace_started",
    target: sub.licenseId,
    after: {
      ...auditSource(ctx, event),
      billingState,
      graceExpiresAt: graceExpiresAt.toISOString(),
    },
  });
}

/**
 * Apply a refund / chargeback (the `revoke` action; FR-010/013). Drives the linked license to the TERMINAL
 * E008 `revoked` status IN THE SHARED TX (never re-implemented here), sets the subscription overlay to
 * `refunded`, and clears any grace. Revoked is TERMINAL and idempotent: revoking an already-revoked license
 * re-applies nothing (the E008 `revokeLicense` is a no-op) and the license is NEVER resurrected by any later
 * event (revoked-not-resurrected guard, FR-010). Audited with the triggering `provider_event_id` on the
 * webhook path, or the synthetic subscription-id + reconcile-job source on the reconciliation path (FR-013).
 */
export async function applyRevoke(
  deps: BillingDeps,
  q: TxQuery,
  tenantId: string,
  sub: SubscriptionRecord,
  event: CanonicalEvent,
  ctx: MutationContext = {},
): Promise<void> {
  const actor = ctx.actor ?? WEBHOOK_ACTOR;
  const lic = await lockLicense(q, sub.licenseId);
  const alreadyRevoked = lic.status === "revoked";
  if (!alreadyRevoked) {
    await revokeLicense(deps.pool, tenantId, actor, sub.licenseId, q); // E008 terminal transition (in-tx)
  }
  // Advance the overlay to refunded + clear grace under the recency guard (a stale refund cannot regress).
  await applySubscriptionState(q, sub.id, { billingState: "refunded", graceExpiresAt: null, occurredAt: event.occurredAt });
  await writeAudit(q, {
    actor,
    action: "billing.revoked",
    target: sub.licenseId,
    after: { ...auditSource(ctx, event), billingState: "refunded", ...(alreadyRevoked ? { alreadyRevoked: true } : {}) },
  });
}

/** Re-export the resolve helper so the webhook orchestrator resolves the existing subscription in-tx. */
export { resolveSubscriptionByExternalId };
