// [Foundational] T007 (FR-009; AD-008, INV-8): dual-identity reseller-audit projection unit tests. Verifies the
// append-only `audit_log` row shape a reseller action produces — `tenant_id` sourced from the live
// `app.current_tenant` GUC (the TARGET sub-tenant scope, never a parameter), `actor` = the reseller-admin user,
// `actor_reseller_id` = the acting reseller's home tenant (NULL for an ordinary non-delegated action) — plus
// JSON before/after serialization and the security-event flag. Pure — no DB: a capturing `TxQuery` records the
// SQL + positional parameters so the dual-identity projection is asserted without a live database.
import { describe, expect, it, vi } from "vitest";

import type { TxQuery } from "../../../db/client.js";
import {
  projectResellerAuditRow,
  RESELLER_AUDIT_INSERT_SQL,
  writeResellerAudit,
} from "../audit.js";

/** A capturing `TxQuery` that records each (text, params) call and returns an empty result. */
function capturingQuery(): { q: TxQuery; calls: { text: string; params?: readonly unknown[] }[] } {
  const calls: { text: string; params?: readonly unknown[] }[] = [];
  const q = vi.fn(async (text: string, params?: readonly unknown[]) => {
    calls.push({ text, params });
    return { rows: [], rowCount: 0 } as unknown as Awaited<ReturnType<TxQuery>>;
  }) as unknown as TxQuery;
  return { q, calls };
}

const SUB_TENANT = "11111111-1111-1111-1111-111111111111";
const RESELLER = "22222222-2222-2222-2222-222222222222";
const ADMIN_USER = "reseller-admin@partner.example";

describe("writeResellerAudit dual-identity projection (INV-8)", () => {
  it("sources tenant_id (target sub-tenant) from the live GUC — never a parameter", async () => {
    const { q, calls } = capturingQuery();
    await writeResellerAudit(q, {
      actor: ADMIN_USER,
      action: "sub_tenant.provision",
      actorResellerId: RESELLER,
      target: SUB_TENANT,
    });
    expect(calls).toHaveLength(1);
    // The row is written under the sub-tenant (target) scope — tenant_id comes from app.current_tenant.
    expect(calls[0]!.text).toContain("INSERT INTO audit_log");
    expect(calls[0]!.text).toContain("current_setting('app.current_tenant')::uuid");
    expect(calls[0]!.text).toContain("actor_reseller_id");
    // tenant_id is NOT a positional parameter; the 7 params are actor..actor_reseller_id.
    expect(calls[0]!.params).toHaveLength(7);
  });

  it("carries BOTH identities: actor = reseller-admin user, actor_reseller_id = acting reseller", async () => {
    const { q, calls } = capturingQuery();
    await writeResellerAudit(q, {
      actor: ADMIN_USER,
      action: "branding.set",
      actorResellerId: RESELLER,
      target: SUB_TENANT,
    });
    const [actor, action, target, before, after, securityEvent, actorResellerId] = calls[0]!.params!;
    expect(actor).toBe(ADMIN_USER);
    expect(action).toBe("branding.set");
    expect(target).toBe(SUB_TENANT);
    expect(before).toBeNull();
    expect(after).toBeNull();
    expect(securityEvent).toBe(false);
    expect(actorResellerId).toBe(RESELLER);
  });

  it("records a NULL actor_reseller_id for an ordinary non-delegated action", () => {
    const row = projectResellerAuditRow({ actor: "operator@platform", action: "reseller.onboard" });
    expect(row.actorResellerId).toBeNull();
  });

  it("JSON-serializes before/after snapshots and defaults the security-event flag", () => {
    const row = projectResellerAuditRow({
      actor: ADMIN_USER,
      action: "quota.update",
      actorResellerId: RESELLER,
      target: SUB_TENANT,
      before: { quota: 10 },
      after: { quota: 25 },
    });
    expect(row.before).toBe('{"quota":10}');
    expect(row.after).toBe('{"quota":25}');
    expect(row.securityEvent).toBe(false);
  });

  it("flags a denied escalation as a security event (HINT-002)", () => {
    const row = projectResellerAuditRow({
      actor: ADMIN_USER,
      action: "sub_tenant.access_denied",
      actorResellerId: RESELLER,
      securityEvent: true,
    });
    expect(row.securityEvent).toBe(true);
    expect(row.target).toBeNull();
  });

  it("uses the append-only audit_log INSERT (SELECT,INSERT-only table — tamper-evident)", () => {
    expect(RESELLER_AUDIT_INSERT_SQL).toContain("INSERT INTO audit_log");
    expect(RESELLER_AUDIT_INSERT_SQL).not.toMatch(/UPDATE|DELETE/);
  });
});
