// Billing-event ledger repository (FR-003/016/020; AD-002, HINT-002). The append-only, per-tenant ledger +
// the idempotency dedup. `recordEvent` INSERTs the row via `ON CONFLICT (tenant_id, provider,
// provider_event_id) DO NOTHING` -- called IN THE SAME transaction as the lifecycle side effect, so an
// at-least-once redelivery conflicts on the UNIQUE, inserts 0 rows, and is reported as a DUPLICATE (never a
// second row, never a re-applied change). A stored row's `outcome` is one of applied / deadletter /
// rejected; `duplicate` is an ACK value, never a stored row. The store is append-only from the app role
// (SELECT + INSERT only): a duplicate READS nothing new, it never mutates. No card/PAN in `payload_summary`.
import { randomUUID } from "node:crypto";

import type { TxQuery } from "../../db/client.js";
import { BillingError } from "./index.js";

/** The STORED ledger outcome (data-model §7). `duplicate` is deliberately NOT here -- it is an ack value only. */
export type EventOutcome = "applied" | "deadletter" | "rejected";

export interface RecordEventInput {
  provider: string;
  /** The provider event id -- the idempotency key `UNIQUE (tenant_id, provider, provider_event_id)` (FR-003). */
  providerEventId: string;
  /** The canonical (adapter-normalized) event type (FR-004). */
  type: string;
  /** The resolved subscription; null when unmapped -> dead-letter (FR-020). */
  subscriptionId: string | null;
  /** The provider event timestamp (epoch SECONDS); ordering + recency guard (FR-016). */
  occurredAt: number;
  outcome: EventOutcome;
  /** Null when `applied`; a reason when deadletter/rejected (the outcome/reason shape CHECK, FR-020). */
  reason: string | null;
  /** Minimized, allow-listed metadata ONLY -- NO card/PAN/PII (FR-018/021). */
  payloadSummary: unknown | null;
}

export interface RecordEventResult {
  /** The new ledger row id; null when the insert was a DUPLICATE no-op (ON CONFLICT, 0 rows). */
  id: string | null;
  /** True when the provider event id already existed -> an idempotent duplicate (no row written) (FR-003). */
  duplicate: boolean;
}

export interface BillingEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  type: string;
  subscriptionId: string | null;
  occurredAt: string; // ISO
  receivedAt: string; // ISO
  outcome: EventOutcome;
  reason: string | null;
  payloadSummary: unknown | null;
}

interface EventRow {
  id: string;
  provider: string;
  provider_event_id: string;
  type: string;
  subscription_id: string | null;
  occurred_at: Date;
  received_at: Date;
  outcome: EventOutcome;
  reason: string | null;
  payload_summary: unknown | null;
}

function toRecord(row: EventRow): BillingEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    type: row.type,
    subscriptionId: row.subscription_id,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    outcome: row.outcome,
    reason: row.reason,
    payloadSummary: row.payload_summary,
  };
}

/** Guard the outcome/reason shape the DB CHECK enforces, so a stub-backed unit test also catches a misuse. */
function assertOutcomeShape(outcome: EventOutcome, reason: string | null): void {
  if (outcome === "applied" && reason != null) {
    throw new BillingError("invalid_event_shape", 500, "an applied event must carry no reason");
  }
  if (outcome !== "applied" && (reason == null || reason === "")) {
    throw new BillingError("invalid_event_shape", 500, `a ${outcome} event must carry a reason`);
  }
}

/**
 * Record one post-verification event in the append-only ledger, deduped by the provider event id (FR-003).
 * MUST be called inside the SAME tenant transaction as the lifecycle side effect (HINT-002): the
 * `ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING` makes an at-least-once redelivery a
 * no-op -- 0 rows inserted, `{ id: null, duplicate: true }` -- so no second row is written and the side
 * effect is applied at most once. A fresh event returns `{ id, duplicate: false }`. `tenant_id` comes from
 * the transaction-local GUC so the write is tenant-scoped under RLS.
 */
export async function recordEvent(q: TxQuery, input: RecordEventInput): Promise<RecordEventResult> {
  assertOutcomeShape(input.outcome, input.reason);
  const id = randomUUID();
  const r = await q(
    `INSERT INTO billing_event
       (id, tenant_id, provider, provider_event_id, type, subscription_id, occurred_at, outcome, reason, payload_summary)
     VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, to_timestamp($6), $7, $8, $9)
     ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [
      id,
      input.provider,
      input.providerEventId,
      input.type,
      input.subscriptionId,
      input.occurredAt,
      input.outcome,
      input.reason,
      input.payloadSummary == null ? null : JSON.stringify(input.payloadSummary),
    ],
  );
  if ((r.rowCount ?? 0) === 0) return { id: null, duplicate: true };
  return { id: (r.rows[0] as { id: string }).id, duplicate: false };
}

/**
 * Record a dead-letter event (FR-020): a validly-signed but unmapped/unhandled event, a delivery to a
 * disabled connection, or a failure after ack -- recorded for operator attention, never silently dropped.
 * `subscriptionId` may be null (unmapped). Deduped like any other event.
 */
export async function deadLetter(
  q: TxQuery,
  input: Omit<RecordEventInput, "outcome">,
): Promise<RecordEventResult> {
  return recordEvent(q, { ...input, outcome: "deadletter" });
}

/** Filters for the operator ledger / dead-letter queue reads (FR-013/020). `cap` bounds the result. */
export interface LedgerFilters {
  outcome?: EventOutcome;
  subscriptionId?: string;
  provider?: string;
  cap: number;
}

/** List ledger rows (bounded, newest-first), optionally filtered by outcome / subscription / provider (FR-013/020). */
export async function listEvents(q: TxQuery, filters: LedgerFilters): Promise<BillingEventRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.outcome) {
    params.push(filters.outcome);
    clauses.push(`outcome = $${params.length}`);
  }
  if (filters.subscriptionId) {
    params.push(filters.subscriptionId);
    clauses.push(`subscription_id = $${params.length}`);
  }
  if (filters.provider) {
    params.push(filters.provider);
    clauses.push(`provider = $${params.length}`);
  }
  params.push(filters.cap);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const r = await q(
    `SELECT id, provider, provider_event_id, type, subscription_id, occurred_at, received_at, outcome, reason, payload_summary
       FROM billing_event ${where}
      ORDER BY received_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return (r.rows as EventRow[]).map(toRecord);
}

/**
 * Prune ledger rows older than the retention horizon (FR-021/SC-015). Deletes every `billing_event` whose
 * server `received_at` predates `olderThanUnix` (epoch SECONDS). This is the PLATFORM RETENTION PATH: the app
 * role holds SELECT/INSERT-only on `billing_event` (append-only, no DELETE grant), so this MUST run on a
 * privileged (owner) transaction, NEVER under `withTenant` — exactly like the E013 `pruneExpiredCheckins`
 * check-in prune. The caller derives `olderThanUnix = now - retention`, with `retention` clamped strictly above
 * the idempotency floor (`IDEMPOTENCY_FLOOR_SECS`) so a still-redeliverable event id is never pruned (FR-003).
 * The `billing_event_prune` BRIN index on `received_at` makes the age-range delete cheap. Returns the count.
 */
export async function pruneBillingEvents(q: TxQuery, olderThanUnix: number): Promise<{ deleted: number }> {
  const r = await q(`DELETE FROM billing_event WHERE received_at < to_timestamp($1)`, [olderThanUnix]);
  return { deleted: r.rowCount ?? 0 };
}
