// Read-only audit review (FR-011/012/013). The audit log is append-only at the database layer (the
// app role holds only INSERT/SELECT on audit_log — E002), so this module deliberately exposes NO
// create/update/delete path: only a tenant-scoped, filtered, keyset-paginated read. Filters: time
// range (from/to), security-events-only, and exact actor. Results are newest-first.
import type pg from "pg";

import { withTenant } from "../../db/client.js";

export interface AuditFilters {
  from?: Date;
  to?: Date;
  securityEvent?: boolean;
  actor?: string;
  /** Opaque keyset cursor from a prior page (see encodeCursor). */
  cursor?: string;
  /** Page size (1..200, default 50). */
  limit?: number;
}

export interface AuditEntryView {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  securityEvent: boolean;
  ts: Date;
}

export interface AuditPage {
  entries: AuditEntryView[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Encode a (ts, id) keyset position as an opaque cursor. */
function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString("base64url");
}

/** Decode an opaque cursor back to (ts, id), or null if malformed. */
function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!ts || !id) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/**
 * Read a page of audit entries newest-first, tenant-scoped by RLS. Keyset pagination on (ts, id)
 * gives stable paging over an append-only, insert-heavy log. Returns `nextCursor` when more remain.
 */
export async function listAuditEntries(
  pool: pg.Pool,
  tenantId: string,
  filters: AuditFilters = {},
): Promise<AuditPage> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.from) {
    params.push(filters.from);
    clauses.push(`ts >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    clauses.push(`ts <= $${params.length}`);
  }
  if (filters.securityEvent) {
    clauses.push("security_event = true");
  }
  if (filters.actor) {
    params.push(filters.actor);
    clauses.push(`actor = $${params.length}`);
  }
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    if (c) {
      params.push(c.ts);
      const tsParam = params.length;
      params.push(c.id);
      const idParam = params.length;
      // Strictly older than the cursor position in (ts, id) descending order.
      clauses.push(`(ts, id) < ($${tsParam}::timestamptz, $${idParam}::uuid)`);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit + 1); // fetch one extra to detect a next page
  const limitParam = params.length;

  return withTenant(pool, tenantId, async (q) => {
    const r = await q(
      `SELECT id, actor, action, target, security_event, ts
         FROM audit_log ${where}
        ORDER BY ts DESC, id DESC
        LIMIT $${limitParam}`,
      params,
    );
    const rows = r.rows as {
      id: string;
      actor: string;
      action: string;
      target: string | null;
      security_event: boolean;
      ts: Date;
    }[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const entries: AuditEntryView[] = page.map((x) => ({
      id: x.id,
      actor: x.actor,
      action: x.action,
      target: x.target,
      securityEvent: x.security_event,
      ts: x.ts,
    }));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.ts, last.id) : null;
    return { entries, nextCursor };
  });
}
