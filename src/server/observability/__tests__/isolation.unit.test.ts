// T030 (OR-011, SC-005 detection half) [COMPLETES OR-011]: the tenant-isolation assertion unit test. Pure
// — NO container, NO database. Asserts the P1 security invariant's DETECTION + SIGNAL contract:
//   1. authenticated-tenant != GUC-tenant → increments tenant_isolation_violation_total AND logs the
//      structured security event with the OR-011 fields.
//   2. same-tenant → SILENT: no counter increment, no log.
//   3. no authenticated request context (background/canary/migration) → SILENT (nothing to compare).
//   4. the assertion issues NO DB query — it compares two in-memory identities only (a query spy passed
//      alongside is never invoked; the assertion has no DB handle by design).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASSERTION_LOCATION,
  assertTenantMatch,
  getIsolationViolationCounter,
  type SecurityEventLogger,
  setSecurityLogger,
} from "../isolation-assertion.js";
import { runWithContext } from "../request-context.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const REQ_ID = "req-abc-123";

/** Read the current value of the labelless isolation-violation counter. */
async function counterValue(): Promise<number> {
  const metric = await getIsolationViolationCounter().get();
  return metric.values[0]?.value ?? 0;
}

/** A capturing fake security logger — records every `error(obj, msg)` call for assertion. */
function fakeLogger(): { logger: SecurityEventLogger; calls: Array<{ obj: Record<string, unknown>; msg?: string }> } {
  const calls: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
  return {
    calls,
    logger: {
      error(obj: object, msg?: string): void {
        calls.push({ obj: obj as Record<string, unknown>, msg });
      },
    },
  };
}

/**
 * A DB query spy — the assertion must NEVER call it (it takes no DB handle). Typed as the pg query shape
 * used across the app so the intent (a real cross-tenant read would go through something like this) is
 * explicit.
 */
let querySpy: ReturnType<typeof vi.fn>;
let captured: ReturnType<typeof fakeLogger>;

beforeEach(() => {
  querySpy = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  captured = fakeLogger();
  setSecurityLogger(captured.logger);
});

afterEach(() => {
  setSecurityLogger(undefined); // restore the default stdout security logger
  vi.restoreAllMocks();
});

describe("assertTenantMatch — mismatch signals (OR-011)", () => {
  it("increments the violation counter AND logs the security event when authenticated tenant != GUC tenant", async () => {
    const before = await counterValue();

    runWithContext({ requestId: REQ_ID, tenantId: TENANT_A }, () => {
      assertTenantMatch(TENANT_B); // GUC scoping to a DIFFERENT tenant than the authenticated principal
    });

    expect(await counterValue()).toBe(before + 1);
    expect(captured.calls).toHaveLength(1);
    const event = captured.calls[0].obj;
    expect(event).toMatchObject({
      event: "tenant_isolation_violation",
      security_event: true,
      request_id: REQ_ID,
      authenticated_tenant: TENANT_A,
      attempted_tenant: TENANT_B,
      assertion_location: ASSERTION_LOCATION,
      source: "assertion",
      outcome: "blocked",
    });
  });

  it("issues NO database query — it compares in-memory identities only (query spy never called)", async () => {
    runWithContext({ requestId: REQ_ID, tenantId: TENANT_A }, () => {
      assertTenantMatch(TENANT_B);
    });
    // The assertion accepts no DB handle by design; the spy that a cross-tenant read WOULD use is untouched.
    expect(querySpy).not.toHaveBeenCalled();
    expect(assertTenantMatch.length).toBe(1); // arity: only the GUC tenant id — no place to pass a query fn
  });
});

describe("assertTenantMatch — silent paths (no false signal, OR-011/012)", () => {
  it("same-tenant is SILENT: no counter increment, no log", async () => {
    const before = await counterValue();
    runWithContext({ requestId: REQ_ID, tenantId: TENANT_A }, () => {
      assertTenantMatch(TENANT_A); // authenticated == GUC
    });
    expect(await counterValue()).toBe(before);
    expect(captured.calls).toHaveLength(0);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("no authenticated request context (background/canary/migration) is SILENT — nothing to compare", async () => {
    const before = await counterValue();
    // Called OUTSIDE any request context (getRequestContext() === undefined).
    assertTenantMatch(TENANT_B);
    expect(await counterValue()).toBe(before);
    expect(captured.calls).toHaveLength(0);
  });

  it("a request context whose tenant is not yet resolved (pre-auth) is SILENT", async () => {
    const before = await counterValue();
    runWithContext({ requestId: REQ_ID }, () => {
      assertTenantMatch(TENANT_B); // tenantId undefined → auth has not resolved a tenant yet
    });
    expect(await counterValue()).toBe(before);
    expect(captured.calls).toHaveLength(0);
  });
});

describe("recordIsolationViolation — signal is never suppressed by a failing logger", () => {
  it("still increments the counter when the security logger throws (fail-open on the log only)", async () => {
    setSecurityLogger({
      error() {
        throw new Error("log sink down");
      },
    });
    const before = await counterValue();
    runWithContext({ requestId: REQ_ID, tenantId: TENANT_A }, () => {
      assertTenantMatch(TENANT_B);
    });
    // The pageable counter fired even though the forensic log write threw.
    expect(await counterValue()).toBe(before + 1);
  });
});
