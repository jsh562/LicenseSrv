// Connection repository (FR-011/015/022; AD-004, HINT-004). Per-tenant provider connection: CRUD, the
// webhook-secret custody, and the grace policy. The inbound-HMAC signing secret is ENVELOPE-ENCRYPTED via
// the E004 keystore custody (generic AES-256-GCM wrap/unwrap -- a DISTINCT, lower-tier secret class from the
// Ed25519 signing key, HINT-004) and is NEVER returned by any API: every read projection here is the
// secret-EXCLUDING `billing_connection_public` view (`ConnectionPublic`). Rotation keeps current + previous
// secrets during a bounded transition window (FR-022). Only `resolveSecrets` (the internal webhook-verify
// path) ever unwraps the secret into memory -- never exposed, never logged.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { type BillingConfig, isRotationWindowOpen } from "./config.js";
import type { Provider } from "./events.js";
import { BillingError, type SecretCustody } from "./index.js";

/** The default custody scheme (matches E004 `KEYSTORE_SCHEME`) -- envelope-encrypt under the keystore master key. */
export const KEYSTORE_SCHEME = "keystore-aes256gcm-v1";

export type ConnectionStatus = "active" | "disabled";

export interface PlanMapping {
  productId: string;
  planId: string;
}
export type PlanMap = Record<string, PlanMapping>;

/** The secret-EXCLUDING connection projection (the `billing_connection_public` view). NEVER carries the secret. */
export interface ConnectionPublic {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  secretCustodyScheme: string;
  secretRotatedAt: string | null; // ISO
  planMap: PlanMap;
  defaultGraceSeconds: number;
  graceOverrides: Record<string, number>;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

interface PublicRow {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  secret_custody_scheme: string;
  secret_rotated_at: Date | null;
  plan_map: PlanMap;
  default_grace_seconds: number;
  grace_overrides: Record<string, number>;
  created_at: Date;
  updated_at: Date;
}

/** The base-table columns of the secret-excluding projection (used for RETURNING; matches the view). */
const PUBLIC_SELECT =
  "id, provider, status, secret_custody_scheme, secret_rotated_at, plan_map, default_grace_seconds, grace_overrides, created_at, updated_at";

function toPublic(row: PublicRow): ConnectionPublic {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    secretCustodyScheme: row.secret_custody_scheme,
    secretRotatedAt: row.secret_rotated_at ? row.secret_rotated_at.toISOString() : null,
    planMap: row.plan_map,
    defaultGraceSeconds: row.default_grace_seconds,
    graceOverrides: row.grace_overrides,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The INTERNAL resolved connection for the webhook-verify path -- carries the UNWRAPPED secret(s) in memory only. */
export interface ResolvedConnection {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  /** The current inbound-HMAC secret (unwrapped) -- used only to recompute the webhook HMAC, never returned. */
  secretCurrent: Buffer;
  /** The previous secret (unwrapped), present ONLY while the rotation transition window is open (FR-022). */
  secretPrev: Buffer | null;
  planMap: PlanMap;
  defaultGraceSeconds: number;
  graceOverrides: Record<string, number>;
}

interface SecretRow {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  signing_secret_ref: Buffer;
  signing_secret_prev: Buffer | null;
  secret_custody_scheme: string;
  secret_rotated_at: Date | null;
  plan_map: PlanMap;
  default_grace_seconds: number;
  grace_overrides: Record<string, number>;
}

export interface CreateConnectionInput {
  provider: Provider;
  /** WRITE-ONLY plaintext signing secret (or a secret-ref name for a secretref scheme). Never stored plaintext. */
  signingSecret: string;
  secretCustodyScheme?: string;
  planMap?: PlanMap;
  defaultGraceSeconds?: number;
  graceOverrides?: Record<string, number>;
}

export interface UpdateConnectionInput {
  status?: ConnectionStatus;
  planMap?: PlanMap;
  defaultGraceSeconds?: number;
  graceOverrides?: Record<string, number>;
  /** OPTIONAL immediate secret replace (NO transition window -- use rotateSecret for a graceful rotation). */
  signingSecret?: string;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/**
 * Per-tenant billing-connection repository. Constructed with the RLS pool, the E004 keystore custody (for
 * envelope-encrypting the webhook secret), and the live billing config (rotation-window resolution). Every
 * method opens its own `withTenant` transaction (the RLS choke point, FR-014).
 */
export class ConnectionRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly custody: SecretCustody | undefined,
    private readonly config: BillingConfig,
  ) {}

  /** Envelope-encrypt a plaintext secret under the keystore custody (fail-closed if custody is locked/absent). */
  private wrapSecret(scheme: string, plaintext: string): Buffer {
    if (scheme !== KEYSTORE_SCHEME) {
      throw new BillingError("unsupported_custody_scheme", 400, `custody scheme not supported: ${scheme}`, {
        field: "secretCustodyScheme",
      });
    }
    if (!this.custody) {
      throw new BillingError("secret_custody_unavailable", 503, "keystore custody is locked or not configured");
    }
    return this.custody.wrap(Buffer.from(plaintext, "utf8"));
  }

  private unwrapSecret(scheme: string, blob: Buffer): Buffer {
    if (scheme !== KEYSTORE_SCHEME) {
      throw new BillingError("unsupported_custody_scheme", 500, `custody scheme not supported: ${scheme}`);
    }
    if (!this.custody) {
      throw new BillingError("secret_custody_unavailable", 503, "keystore custody is locked or not configured");
    }
    return this.custody.unwrap(blob);
  }

  /**
   * Create a provider connection (FR-015). The signing secret is wrapped BEFORE insert (never plaintext at
   * rest) and never returned -- the response is the secret-excluding `ConnectionPublic`. One connection per
   * `(tenant, provider)`: a second → `409 duplicate_connection`. Audited (FR-013).
   */
  create(tenantId: string, actor: string, input: CreateConnectionInput): Promise<ConnectionPublic> {
    const scheme = input.secretCustodyScheme ?? KEYSTORE_SCHEME;
    const wrapped = this.wrapSecret(scheme, input.signingSecret);
    const id = randomUUID();
    return withTenant(this.pool, tenantId, async (q) => {
      let r: pg.QueryResult;
      try {
        r = await q(
          `INSERT INTO billing_connection
             (id, tenant_id, provider, signing_secret_ref, secret_custody_scheme, plan_map, default_grace_seconds, grace_overrides)
           VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
           RETURNING ${PUBLIC_SELECT}`,
          [
            id,
            input.provider,
            wrapped,
            scheme,
            JSON.stringify(input.planMap ?? {}),
            input.defaultGraceSeconds ?? this.config.defaultGraceSeconds,
            JSON.stringify(input.graceOverrides ?? {}),
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new BillingError("duplicate_connection", 409, "a connection already exists for this provider", {
            provider: input.provider,
          });
        }
        throw e;
      }
      await writeAudit(q, { actor, action: "billing.connection.created", target: id, after: { provider: input.provider } });
      return toPublic(r.rows[0] as PublicRow);
    });
  }

  /** List the tenant's connections via the secret-excluding view (bounded, newest-first). Secret never present. */
  list(tenantId: string, cap = 1000): Promise<ConnectionPublic[]> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(
        `SELECT ${PUBLIC_SELECT} FROM billing_connection_public ORDER BY created_at DESC, id DESC LIMIT $1`,
        [cap],
      );
      return (r.rows as PublicRow[]).map(toPublic);
    });
  }

  /** Get one connection via the secret-excluding view, or null. Secret never present. */
  get(tenantId: string, id: string): Promise<ConnectionPublic | null> {
    return withTenant(this.pool, tenantId, async (q) => {
      const r = await q(`SELECT ${PUBLIC_SELECT} FROM billing_connection_public WHERE id = $1`, [id]);
      return r.rowCount ? toPublic(r.rows[0] as PublicRow) : null;
    });
  }

  /**
   * Update a connection's status / plan map / grace policy, and OPTIONALLY replace the secret immediately (no
   * transition window). `provider` is immutable. Only supplied fields change. Returns the secret-excluding
   * projection; 404 if unknown in the tenant. Audited (FR-013).
   */
  update(tenantId: string, actor: string, id: string, input: UpdateConnectionInput): Promise<ConnectionPublic> {
    return withTenant(this.pool, tenantId, async (q) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const push = (frag: string, value: unknown): void => {
        params.push(value);
        sets.push(frag.replace("$$", `$${params.length}`));
      };
      if (input.status !== undefined) push("status = $$", input.status);
      if (input.planMap !== undefined) push("plan_map = $$::jsonb", JSON.stringify(input.planMap));
      if (input.defaultGraceSeconds !== undefined) push("default_grace_seconds = $$", input.defaultGraceSeconds);
      if (input.graceOverrides !== undefined) push("grace_overrides = $$::jsonb", JSON.stringify(input.graceOverrides));
      if (input.signingSecret !== undefined) {
        // Immediate replace: re-wrap under the existing scheme. No transition window (rotate-secret for that).
        const scheme = (await this.currentScheme(q, id)) ?? KEYSTORE_SCHEME;
        push("signing_secret_ref = $$", this.wrapSecret(scheme, input.signingSecret));
      }
      if (sets.length === 0) {
        const cur = await q(`SELECT ${PUBLIC_SELECT} FROM billing_connection_public WHERE id = $1`, [id]);
        if (!cur.rowCount) throw new BillingError("connection_not_found", 404, "unknown connection", { connectionId: id });
        return toPublic(cur.rows[0] as PublicRow);
      }
      const r = await q(
        `UPDATE billing_connection SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${PUBLIC_SELECT}`,
        params,
      );
      if (!r.rowCount) throw new BillingError("connection_not_found", 404, "unknown connection", { connectionId: id });
      await writeAudit(q, { actor, action: "billing.connection.updated", target: id });
      return toPublic(r.rows[0] as PublicRow);
    });
  }

  private async currentScheme(q: TxQuery, id: string): Promise<string | null> {
    const r = await q("SELECT secret_custody_scheme FROM billing_connection WHERE id = $1", [id]);
    return r.rowCount ? (r.rows[0] as { secret_custody_scheme: string }).secret_custody_scheme : null;
  }

  /**
   * Rotate the signing secret with a transition window (FR-022; US5-AC2). The new secret becomes the current
   * `signing_secret_ref`; the outgoing secret is retained as `signing_secret_prev` and `secret_rotated_at` is
   * stamped, so the verifier accepts BOTH while the window is open (`resolveSecrets`). Neither secret is ever
   * returned. 404 if unknown. Audited (FR-013).
   */
  rotateSecret(tenantId: string, actor: string, id: string, newSecret: string): Promise<ConnectionPublic> {
    return withTenant(this.pool, tenantId, async (q) => {
      const scheme = (await this.currentScheme(q, id)) ?? KEYSTORE_SCHEME;
      const wrapped = this.wrapSecret(scheme, newSecret);
      const r = await q(
        `UPDATE billing_connection
            SET signing_secret_prev = signing_secret_ref,
                signing_secret_ref  = $2,
                secret_rotated_at   = now(),
                updated_at          = now()
          WHERE id = $1
          RETURNING ${PUBLIC_SELECT}`,
        [id, wrapped],
      );
      if (!r.rowCount) throw new BillingError("connection_not_found", 404, "unknown connection", { connectionId: id });
      await writeAudit(q, { actor, action: "billing.connection.secret_rotated", target: id });
      return toPublic(r.rows[0] as PublicRow);
    });
  }

  /**
   * Resolve a connection's UNWRAPPED secret(s) for webhook verification (INTERNAL only -- never exposed). The
   * previous secret is included ONLY while the rotation transition window is open (FR-022). Returns null when
   * the connection id does not resolve in the tenant. Tx-composable so it runs in the webhook verify tx.
   */
  async resolveSecrets(q: TxQuery, id: string): Promise<ResolvedConnection | null> {
    const r = await q(
      `SELECT id, provider, status, signing_secret_ref, signing_secret_prev, secret_custody_scheme,
              secret_rotated_at, plan_map, default_grace_seconds, grace_overrides
         FROM billing_connection WHERE id = $1`,
      [id],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0] as SecretRow;
    const secretCurrent = this.unwrapSecret(row.secret_custody_scheme, row.signing_secret_ref);
    let secretPrev: Buffer | null = null;
    if (row.signing_secret_prev && isRotationWindowOpen(this.config, row.secret_rotated_at)) {
      secretPrev = this.unwrapSecret(row.secret_custody_scheme, row.signing_secret_prev);
    }
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      secretCurrent,
      secretPrev,
      planMap: row.plan_map,
      defaultGraceSeconds: row.default_grace_seconds,
      graceOverrides: row.grace_overrides,
    };
  }
}
