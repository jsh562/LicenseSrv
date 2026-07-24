// Lease repository (E015, FR-003/007/008/009/010/011/014; ADR-0012). The shared, race-safe ACCOUNTANT every
// story composes: a per-license advisory-locked count+insert ACQUIRE (AD-001/HINT-001), a generation-fenced
// RENEW (AD-003/HINT-002), an idempotent RELEASE, a bounded oldest-first reclaim SWEEP (FR-010), and the
// operator LIST. [COMPLETES FR-009]
//
// All methods take the caller's tenant transaction `q` (a `withTenant` TxQuery) so the acquire's advisory
// lock, live count, and insert run in ONE transaction — the lock auto-releases at COMMIT (a naive
// `WHERE live_count < cap` races and OVER-ALLOCATES; INV-1). RLS scopes every statement to the caller's
// tenant, so a cross-tenant id simply resolves to zero rows (FR-019).
import { randomUUID } from "node:crypto";

import type { TxQuery } from "../../db/client.js";
import { type ConcurrencyScope, effectiveCap, isOverageSeat, resolveScope } from "./config.js";
import { holderKeyToString } from "./holder-key.js";

export type LeaseStatus = "live" | "released" | "reclaimed";

/** A lease row mapped for the service layer. `holderKey` is the pseudonymous string (never the raw ref). */
export interface LeaseRecord {
  id: string;
  licenseId: string;
  holderKey: string;
  scope: ConcurrencyScope;
  status: LeaseStatus;
  acquiredAt: string;
  lastRenewedAt: string;
  expiresAt: string;
  generation: number;
  overage: boolean;
  activationId: string | null;
  nonce: string;
  handleKeyId: string | null;
  endedAt: string | null;
}

interface LeaseRow {
  id: string;
  license_id: string;
  holder_key: Buffer;
  concurrency_scope: string;
  status: LeaseStatus;
  acquired_at: Date;
  last_renewed_at: Date;
  expires_at: Date;
  generation: string; // bigint over the wire
  overage: boolean;
  activation_id: string | null;
  nonce: string;
  handle_key_id: string | null;
  ended_at: Date | null;
}

const LEASE_COLUMNS =
  "id, license_id, holder_key, concurrency_scope, status, acquired_at, last_renewed_at, expires_at, " +
  "generation, overage, activation_id, nonce, handle_key_id, ended_at";

function mapLeaseRow(row: unknown): LeaseRecord {
  const r = row as LeaseRow;
  return {
    id: r.id,
    licenseId: r.license_id,
    holderKey: holderKeyToString(r.holder_key),
    scope: resolveScope(r.concurrency_scope),
    status: r.status,
    acquiredAt: r.acquired_at.toISOString(),
    lastRenewedAt: r.last_renewed_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    generation: Number(r.generation),
    overage: r.overage,
    activationId: r.activation_id,
    nonce: r.nonce,
    handleKeyId: r.handle_key_id,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  };
}

/** The inputs to a race-safe acquire. `holderKey` is the derived salted-hash digest (bytea); raw never stored. */
export interface AcquireParams {
  licenseId: string;
  holderKey: Buffer;
  scope: ConcurrencyScope;
  nonce: string;
  ttlSeconds: number;
  maxConcurrent: number;
  overageAllowance: number;
  activationId?: string | null;
  handleKeyId?: string | null;
}

/**
 * The discriminated outcome of {@link LeaseRepo.acquire}. `created` = a NEW seat consumed (201); `replayed` =
 * the idempotent re-use of an existing lease — same acquire nonce OR the one-live-per-holder invariant — with
 * NO second seat (200); `capacity` = the effective cap is reached, NO partial lease recorded (409). Mapping
 * to HTTP is the route's job (US1).
 */
export type AcquireOutcome =
  | { kind: "created"; lease: LeaseRecord; concurrencyUsed: number }
  | { kind: "replayed"; lease: LeaseRecord; concurrencyUsed: number }
  | { kind: "capacity"; concurrencyUsed: number; maxConcurrent: number; overageAllowance: number };

/** The result of a renew: the refreshed lease, or `null` when the generation fence / live predicate missed. */
export type RenewOutcome = LeaseRecord | null;

/** A reclaimed lease returned by a sweep run (the affected ids for the synthetic-actor audit, FR-018). */
export interface ReclaimedLease {
  id: string;
  licenseId: string;
}

/** The bounded operator lease registry (FR-015): the leases plus a `truncated` signal. */
export interface LeaseListResult {
  leases: LeaseRecord[];
  truncated: boolean;
}

/**
 * The pure renew fence + live predicate (AD-003/FR-011, INV-3), mirroring the SQL guard so it is unit-
 * testable: a lease is renewable only while it is `live`, unexpired at `now`, and (when an `expectedGeneration`
 * is supplied) its generation matches. A stale renew racing a reclaim fails one of these and touches 0 rows,
 * so a reclaimed seat is NEVER revived or double-counted.
 */
export function passesRenewFence(
  lease: Pick<LeaseRecord, "status" | "expiresAt" | "generation">,
  now: Date,
  expectedGeneration?: number,
): boolean {
  if (lease.status !== "live") return false;
  if (new Date(lease.expiresAt).getTime() <= now.getTime()) return false;
  if (expectedGeneration !== undefined && lease.generation !== expectedGeneration) return false;
  return true;
}

export class LeaseRepo {
  /**
   * Race-safe acquire (AD-001/HINT-001, INV-1). Inside the caller's tenant tx `q`: takes a per-license
   * `pg_advisory_xact_lock` (tiny critical section on the hot license row), replays an existing lease for a
   * reused acquire nonce OR a holder that already holds a live lease (idempotent, NO second seat, FR-014/023),
   * takes the authoritative live count UNDER the lock, refuses at the effective cap with no partial row
   * (FR-003/004/012), else inserts the lease with a server-computed `expires_at = now + ttl` and the overage
   * flag. The advisory lock releases at COMMIT.
   */
  async acquire(q: TxQuery, params: AcquireParams): Promise<AcquireOutcome> {
    // 1. Serialize ONLY the hot license row (license_id is a globally-unique uuid) — a tiny critical section.
    await q("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [params.licenseId]);

    // 2. Anti-replay (FR-014): a reused acquire nonce replays the ORIGINAL lease, consuming no second seat.
    const byNonce = await q(`SELECT ${LEASE_COLUMNS} FROM lease WHERE nonce = $1`, [params.nonce]);
    if (byNonce.rowCount) {
      const lease = mapLeaseRow(byNonce.rows[0]);
      return { kind: "replayed", lease, concurrencyUsed: await this.countLive(q, params.licenseId) };
    }

    // 3. One live lease per (license, holder-key) (FR-023, INV-2): a holder that already holds a live lease
    //    re-uses it — the seat-uniqueness invariant, idempotent across restarts within the replay window.
    const byHolder = await q(
      `SELECT ${LEASE_COLUMNS} FROM lease WHERE license_id = $1 AND holder_key = $2 AND status = 'live'`,
      [params.licenseId, params.holderKey],
    );
    if (byHolder.rowCount) {
      const lease = mapLeaseRow(byHolder.rows[0]);
      return { kind: "replayed", lease, concurrencyUsed: await this.countLive(q, params.licenseId) };
    }

    // 4. Authoritative live count UNDER the advisory lock.
    const used = await this.countLive(q, params.licenseId);

    // 5. Refuse at the effective cap (max_concurrent + overage) with NO partial lease (FR-004/012, INV-1).
    if (used >= effectiveCap(params.maxConcurrent, params.overageAllowance)) {
      return {
        kind: "capacity",
        concurrencyUsed: used,
        maxConcurrent: params.maxConcurrent,
        overageAllowance: params.overageAllowance,
      };
    }

    // 6. Insert the lease; a seat over the base cap is flagged `overage` (metered authoritatively in audit).
    const overage = isOverageSeat(used, params.maxConcurrent);
    const id = randomUUID();
    try {
      const ins = await q(
        `INSERT INTO lease
           (id, tenant_id, license_id, holder_key, concurrency_scope, status,
            expires_at, generation, overage, activation_id, nonce, handle_key_id)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, 'live',
            now() + make_interval(secs => $5), 0, $6, $7, $8, $9)
         RETURNING ${LEASE_COLUMNS}`,
        [
          id,
          params.licenseId,
          params.holderKey,
          params.scope,
          params.ttlSeconds,
          overage,
          params.activationId ?? null,
          params.nonce,
          params.handleKeyId ?? null,
        ],
      );
      return { kind: "created", lease: mapLeaseRow(ins.rows[0]), concurrencyUsed: used + 1 };
    } catch (e) {
      // A concurrent acquire that grabbed the SAME nonce on a DIFFERENT license (not serialized by our
      // per-license lock) loses the UNIQUE (tenant_id, nonce) race — replay the ORIGINAL lease (FR-014).
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
        const replay = await q(`SELECT ${LEASE_COLUMNS} FROM lease WHERE nonce = $1`, [params.nonce]);
        if (replay.rowCount) {
          return {
            kind: "replayed",
            lease: mapLeaseRow(replay.rows[0]),
            concurrencyUsed: await this.countLive(q, params.licenseId),
          };
        }
      }
      throw e;
    }
  }

  /**
   * Generation-fenced renew (AD-003/HINT-002, INV-3). A single guarded UPDATE extends `expires_at` to a
   * SERVER-computed `now + ttl`, advances `last_renewed_at`, and BUMPS `generation`, matching only a lease
   * that is still `live`, unexpired, and (when `expectedGeneration` is supplied) at the expected generation.
   * A stale/late renew after a reclaim matches 0 rows → returns `null` (the route maps to
   * `409 lease_not_renewable`); a reclaimed seat is never revived or double-counted (FR-011).
   */
  async renew(
    q: TxQuery,
    params: { leaseId: string; ttlSeconds: number; expectedGeneration?: number },
  ): Promise<RenewOutcome> {
    const conds = ["id = $1", "status = 'live'", "expires_at > now()"];
    const args: unknown[] = [params.leaseId, params.ttlSeconds];
    if (params.expectedGeneration !== undefined) {
      conds.push("generation = $3");
      args.push(params.expectedGeneration);
    }
    const res = await q(
      `UPDATE lease
          SET last_renewed_at = now(),
              expires_at      = now() + make_interval(secs => $2),
              generation      = generation + 1,
              updated_at      = now()
        WHERE ${conds.join(" AND ")}
        RETURNING ${LEASE_COLUMNS}`,
      args,
    );
    return res.rowCount ? mapLeaseRow(res.rows[0]) : null;
  }

  /**
   * Idempotent release (FR-008, INV-11). Flips a LIVE lease to `released` with `ended_at = now`, freeing the
   * seat immediately. An unknown / already-ended / cross-tenant `leaseId` matches 0 rows and is a `200`
   * no-op that frees NOTHING (never driving the live count below zero). `changed` reports whether a live seat
   * was actually freed (for the audit trail).
   */
  async release(q: TxQuery, leaseId: string): Promise<{ id: string; status: "released"; changed: boolean }> {
    const res = await q(
      `UPDATE lease SET status = 'released', ended_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'live' RETURNING id`,
      [leaseId],
    );
    return { id: leaseId, status: "released", changed: (res.rowCount ?? 0) > 0 };
  }

  /**
   * Force-release (operator/admin, FR-016). Like {@link release} but flips a LIVE lease to `reclaimed`
   * (operator-driven seat recovery), idempotent for an already-ended/unknown id. `changed` reports whether a
   * live seat was freed.
   */
  async forceRelease(q: TxQuery, leaseId: string): Promise<{ id: string; status: "reclaimed"; changed: boolean }> {
    const res = await q(
      `UPDATE lease SET status = 'reclaimed', ended_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'live' RETURNING id`,
      [leaseId],
    );
    return { id: leaseId, status: "reclaimed", changed: (res.rowCount ?? 0) > 0 };
  }

  /**
   * Bounded, oldest-first reclaim sweep (FR-010, AD-002). Reclaims up to `maxBatch` LIVE leases whose
   * `expires_at + license.lease_grace_seconds < now` (server time — the grace window absorbs client/network
   * skew), ordered ascending by `expires_at` (served by the `lease_reclaim` partial index) so the oldest-
   * expired seats free first. `FOR UPDATE ... SKIP LOCKED` keeps concurrent sweeps disjoint; the predicate
   * only matches still-live, past-grace rows, so consecutive runs are idempotent and a large lapsed set
   * drains deterministically across intervals with no double-reclaim. An optional `licenseId` narrows the
   * sweep to one license (the revoke-reclaim reuse path, FR-024).
   */
  async sweep(q: TxQuery, params: { maxBatch: number; licenseId?: string }): Promise<ReclaimedLease[]> {
    const filter = params.licenseId ? "AND l.license_id = $2" : "";
    const args: unknown[] = [params.maxBatch];
    if (params.licenseId) args.push(params.licenseId);
    const res = await q(
      `WITH due AS (
         SELECT l.id
           FROM lease l
           JOIN license lic ON lic.tenant_id = l.tenant_id AND lic.id = l.license_id
          WHERE l.status = 'live'
            AND l.expires_at + make_interval(secs => lic.lease_grace_seconds) < now()
            ${filter}
          ORDER BY l.expires_at ASC
          LIMIT $1
          FOR UPDATE OF l SKIP LOCKED
       )
       UPDATE lease SET status = 'reclaimed', ended_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM due)
        RETURNING id, license_id`,
      args,
    );
    return (res.rows as { id: string; license_id: string }[]).map((r) => ({ id: r.id, licenseId: r.license_id }));
  }

  /** The authoritative live-lease count for a license (COUNT(*) WHERE status='live'); tenant-scoped by RLS. */
  async countLive(q: TxQuery, licenseId: string): Promise<number> {
    const r = await q("SELECT count(*)::int AS n FROM lease WHERE license_id = $1 AND status = 'live'", [licenseId]);
    return (r.rows[0] as { n: number }).n;
  }

  /** Read a single lease by id within the tenant (RLS-scoped); `null` for unknown/cross-tenant (FR-019). */
  async getById(q: TxQuery, leaseId: string): Promise<LeaseRecord | null> {
    const r = await q(`SELECT ${LEASE_COLUMNS} FROM lease WHERE id = $1`, [leaseId]);
    return r.rowCount ? mapLeaseRow(r.rows[0]) : null;
  }

  /**
   * List a license's leases for the operator registry (FR-015). Deterministically ordered (`acquired_at`
   * DESC, ties broken by `id` DESC), optionally narrowed by `status`, bounded to a hard `cap` with a
   * `truncated` signal (one extra row is fetched to detect truncation). Tenant-scoped by RLS. When
   * `displayWindowSeconds` is supplied (the registry's default 24h window, FR-015), LIVE leases are ALWAYS
   * shown while terminal (released/reclaimed) leases are shown only if they ended within the window — so the
   * registry surfaces live + RECENTLY-ended leases without unbounded history.
   */
  async list(
    q: TxQuery,
    params: { licenseId: string; status?: LeaseStatus; cap: number; displayWindowSeconds?: number },
  ): Promise<LeaseListResult> {
    const args: unknown[] = [params.licenseId, params.cap + 1];
    const clauses = ["license_id = $1"];
    if (params.status) {
      args.push(params.status);
      clauses.push(`status = $${args.length}`);
    }
    if (params.displayWindowSeconds !== undefined) {
      args.push(params.displayWindowSeconds);
      // Live leases always show; ended leases only within the recent display window (by ended_at).
      clauses.push(`(status = 'live' OR ended_at >= now() - make_interval(secs => $${args.length}))`);
    }
    const res = await q(
      `SELECT ${LEASE_COLUMNS} FROM lease
        WHERE ${clauses.join(" AND ")}
        ORDER BY acquired_at DESC, id DESC
        LIMIT $2`,
      args,
    );
    const rows = res.rows.map(mapLeaseRow);
    const truncated = rows.length > params.cap;
    return { leases: truncated ? rows.slice(0, params.cap) : rows, truncated };
  }
}
