// User + role management (FR-006/007/008, AD-008). An admin creates/invites users, changes a user's
// role, and deactivates them — every change audited. The last-owner safeguard makes demoting or
// deactivating the final active owner impossible, and does so race-safely: concurrent attempts
// serialize on `SELECT ... FOR UPDATE` over the active-owner set, so two requests can never each
// believe another owner remains. A user's console role is a single role row (highest-role semantics).
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { recordSecurityEvent, writeAudit } from "../../audit/index.js";
import type { Role } from "../../auth/rbac.js";
import { withTenant } from "../../db/client.js";
import { hmacKey } from "../../db/hash.js";
import { hashPassword } from "./password.js";

export type UserStatus = "invited" | "active" | "deactivated";

export interface CreateUserInput {
  email: string;
  role: Role;
  /** Optional initial password. Omitted → the user is 'invited' (no credential yet). */
  password?: string;
}

export type CreateUserOutcome =
  | { ok: true; id: string; status: UserStatus }
  | { ok: false; reason: "duplicate" };

export interface UpdateUserInput {
  role?: Role;
  status?: Extract<UserStatus, "active" | "deactivated">;
}

export type UpdateUserOutcome =
  | { ok: true; role: Role; status: UserStatus }
  | { ok: false; reason: "not-found" | "last-owner" };

const UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
}

/** The tenant's highest role for a user, or null if the user holds no role. */
function highest(roles: Role[]): Role | null {
  const order: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };
  if (!roles.length) return null;
  return roles.reduce((best, cur) => (order[cur] > order[best] ? cur : best));
}

/**
 * Create (or invite) a user with a single console role. Enumeration-safe at the API edge: a duplicate
 * email in the tenant returns `{ ok:false, reason:"duplicate" }` (the route maps it to 409).
 */
export async function createUser(
  pool: pg.Pool,
  secret: string,
  tenantId: string,
  actor: string,
  input: CreateUserInput,
): Promise<CreateUserOutcome> {
  const id = randomUUID();
  const emailHash = hmacKey(input.email.trim().toLowerCase(), secret);
  const status: UserStatus = input.password ? "active" : "invited";
  const passwordHash = input.password ? hashPassword(input.password) : null;

  try {
    await withTenant(pool, tenantId, async (q) => {
      await q(
        `INSERT INTO app_user (id, tenant_id, email_hash, password_hash, status)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)`,
        [id, emailHash, passwordHash, status],
      );
      await q(
        `INSERT INTO role (id, tenant_id, user_id, role, granted_by)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)`,
        [randomUUID(), id, input.role, actor],
      );
      await writeAudit(q, { actor, action: "user.created", target: id, after: { role: input.role, status } });
    });
    return { ok: true, id, status };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

/**
 * Change a user's role and/or status. Refuses (409) to demote or deactivate the final active owner
 * (FR-008). The guard locks the active-owner set FOR UPDATE inside the same transaction, so a race
 * between two owner-removals cannot leave the tenant ownerless.
 */
export async function updateUser(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  userId: string,
  input: UpdateUserInput,
): Promise<UpdateUserOutcome> {
  return withTenant(pool, tenantId, async (q): Promise<UpdateUserOutcome> => {
    const userRow = await q("SELECT status FROM app_user WHERE id = $1 FOR UPDATE", [userId]);
    if (!userRow.rowCount) return { ok: false, reason: "not-found" };
    const currentStatus = (userRow.rows[0] as { status: UserStatus }).status;

    const roleRows = await q("SELECT role FROM role WHERE user_id = $1", [userId]);
    const currentRole = highest((roleRows.rows as { role: Role }[]).map((r) => r.role)) ?? "viewer";
    const isOwner = currentRole === "owner";

    const demotingOwner = isOwner && input.role !== undefined && input.role !== "owner";
    const deactivatingOwner = isOwner && input.status === "deactivated";

    if (demotingOwner || deactivatingOwner) {
      // Serialize concurrent owner-removals: lock every active owner row, then require another to
      // remain. (No DISTINCT — Postgres forbids FOR UPDATE with DISTINCT; we dedupe by id in JS.)
      const owners = await q(
        `SELECT u.id
           FROM app_user u
           JOIN role r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
          WHERE r.role = 'owner' AND u.status = 'active'
          FOR UPDATE`,
        [],
      );
      const otherActiveOwners = new Set(
        (owners.rows as { id: string }[]).map((o) => o.id).filter((id) => id !== userId),
      );
      if (otherActiveOwners.size === 0) {
        await recordSecurityEvent(q, {
          actor,
          action: "user.last_owner_blocked",
          target: userId,
        });
        return { ok: false, reason: "last-owner" };
      }
    }

    const before = { role: currentRole, status: currentStatus };

    if (input.role !== undefined && input.role !== currentRole) {
      await q("DELETE FROM role WHERE user_id = $1", [userId]);
      await q(
        `INSERT INTO role (id, tenant_id, user_id, role, granted_by)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4)`,
        [randomUUID(), userId, input.role, actor],
      );
    }
    if (input.status !== undefined && input.status !== currentStatus) {
      await q("UPDATE app_user SET status = $2 WHERE id = $1", [userId, input.status]);
    }

    const after = { role: input.role ?? currentRole, status: input.status ?? currentStatus };
    await writeAudit(q, { actor, action: "user.updated", target: userId, before, after });
    return { ok: true, role: after.role, status: after.status };
  });
}

/** List users (metadata only — never the credential hash). Admin view. */
export async function listUsers(
  pool: pg.Pool,
  tenantId: string,
): Promise<Array<{ id: string; status: UserStatus; role: Role; createdAt: Date }>> {
  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `SELECT u.id, u.status, u.created_at,
              (SELECT r.role FROM role r WHERE r.user_id = u.id
                ORDER BY CASE r.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END DESC
                LIMIT 1) AS role
         FROM app_user u
        ORDER BY u.created_at ASC`,
      [],
    );
    return (r.rows as { id: string; status: UserStatus; role: Role | null; created_at: Date }[]).map((x) => ({
      id: x.id,
      status: x.status,
      role: x.role ?? "viewer",
      createdAt: x.created_at,
    }));
  });
}
