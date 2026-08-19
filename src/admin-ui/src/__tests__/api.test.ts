// The API client contract (FR-015/019): cookies ride along, the CSRF token is echoed on mutations,
// non-2xx becomes a typed ApiError, and 204 resolves void. Drives the real client against a mocked
// fetch (this file must NOT mock ../api — it is the unit under test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activationApi,
  adminApi,
  ApiError,
  billingApi,
  catalogApi,
  leaseApi,
  licensingApi,
  policyApi,
  readCookie,
  resellerApi,
  usageApi,
} from "../api";

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  document.cookie = "admin_csrf=csrf-tok-123";
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "admin_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

describe("adminApi client", () => {
  it("reads the CSRF cookie", () => {
    expect(readCookie("admin_csrf")).toBe("csrf-tok-123");
    expect(readCookie("nope")).toBeUndefined();
  });

  it("sends credentials and echoes X-CSRF-Token on a mutating call", async () => {
    const fn = mockFetch(201, { id: "u1", status: "invited" });
    await adminApi.createUser({ email: "a@b.c", role: "viewer" });
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/admin/users");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-tok-123");
    expect(init.method).toBe("POST");
  });

  it("does NOT attach a CSRF header on a GET", async () => {
    const fn = mockFetch(200, { users: [] });
    await adminApi.listUsers();
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("throws a typed ApiError carrying the server code on a non-2xx", async () => {
    mockFetch(429, { code: "account_locked", message: "locked" });
    await expect(adminApi.login("t", "e", "p")).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      code: "account_locked",
    });
    await expect(adminApi.login("t", "e", "p")).rejects.toBeInstanceOf(ApiError);
  });

  it("resolves void on a 204 (logout)", async () => {
    mockFetch(204, undefined);
    await expect(adminApi.logout()).resolves.toBeUndefined();
  });

  it("exposes every endpoint against the expected method + path", async () => {
    const fn = mockFetch(200, { userId: "u1", tenantId: "t1", role: "owner", users: [], keys: [], id: "x", status: "revoked", secret: "lsk_s", scopes: [] });
    await adminApi.me();
    await adminApi.updateUser("u1", { role: "admin" });
    await adminApi.listApiKeys();
    await adminApi.createApiKey(["validate"]);
    await adminApi.rotateApiKey("k1");
    await adminApi.revokeApiKey("k1");
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/auth/me"],
      ["PATCH", "/admin/users/u1"],
      ["GET", "/admin/api-keys"],
      ["POST", "/admin/api-keys"],
      ["POST", "/admin/api-keys/k1/rotate"],
      ["POST", "/admin/api-keys/k1/revoke"],
    ]);
  });

  it("serializes audit filters into the query string", async () => {
    const fn = mockFetch(200, { entries: [], nextCursor: null });
    await adminApi.listAudit({ securityEvent: true, actor: "u1", limit: 25 });
    const [url] = fn.mock.calls[0] as [string];
    expect(url).toContain("/admin/audit?");
    expect(url).toContain("securityEvent=true");
    expect(url).toContain("actor=u1");
    expect(url).toContain("limit=25");
  });
});

describe("catalogApi client", () => {
  it("exposes every catalog endpoint at the expected method + path", async () => {
    const fn = mockFetch(200, {
      products: [], plans: [], entitlements: [],
      id: "x", key: "k", name: "n", status: "active", type: "boolean", value: true, entitlementId: "e", productId: "p",
    });
    await catalogApi.listProducts("all");
    await catalogApi.createProduct({ key: "acme", name: "Acme" });
    await catalogApi.archiveProduct("p1");
    await catalogApi.listPlans("p1", "active");
    await catalogApi.createPlan("p1", { key: "std", name: "Std", maxActivations: 5 });
    await catalogApi.archivePlan("pl1");
    await catalogApi.listEntitlements();
    await catalogApi.createEntitlement({ key: "f", name: "F", type: "boolean" });
    await catalogApi.archiveEntitlement("e1");
    await catalogApi.listPlanEntitlements("pl1");
    await catalogApi.setPlanValue("pl1", "e1", true);
    await catalogApi.removePlanValue("pl1", "e1");
    await catalogApi.getEffective("pl1");
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/catalog/products?status=all"],
      ["POST", "/admin/catalog/products"],
      ["POST", "/admin/catalog/products/p1/archive"],
      ["GET", "/admin/catalog/products/p1/plans?status=active"],
      ["POST", "/admin/catalog/products/p1/plans"],
      ["POST", "/admin/catalog/plans/pl1/archive"],
      ["GET", "/admin/catalog/entitlements"],
      ["POST", "/admin/catalog/entitlements"],
      ["POST", "/admin/catalog/entitlements/e1/archive"],
      ["GET", "/admin/catalog/plans/pl1/entitlements"],
      ["PUT", "/admin/catalog/plans/pl1/entitlements/e1"],
      ["DELETE", "/admin/catalog/plans/pl1/entitlements/e1"],
      ["GET", "/admin/catalog/plans/pl1/effective"],
    ]);
  });
});

describe("licensingApi client", () => {
  it("exposes every licensing endpoint at the expected method + path", async () => {
    const fn = mockFetch(200, { customers: [], licenses: [], licenseKey: "LIC1.x", id: "x", ref: "r", status: "active" });
    await licensingApi.listCustomers();
    await licensingApi.createCustomer({ ref: "acct-1" });
    await licensingApi.getCustomer("c1");
    await licensingApi.eraseCustomer("c1");
    await licensingApi.issueLicense({ planId: "pl1", customerId: "c1" });
    await licensingApi.listLicenses({ status: "active", customerId: "c1", planId: "pl1" });
    await licensingApi.getLicense("l1");
    await licensingApi.getLicenseKey("l1");
    await licensingApi.revokeLicense("l1");
    await licensingApi.suspendLicense("l1");
    await licensingApi.reinstateLicense("l1");
    await licensingApi.transferLicense("l1", "c2");
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/customers"],
      ["POST", "/admin/customers"],
      ["GET", "/admin/customers/c1"],
      ["DELETE", "/admin/customers/c1"],
      ["POST", "/admin/licenses"],
      ["GET", "/admin/licenses?status=active&customerId=c1&planId=pl1"],
      ["GET", "/admin/licenses/l1"],
      ["GET", "/admin/licenses/l1/key"],
      ["POST", "/admin/licenses/l1/revoke"],
      ["POST", "/admin/licenses/l1/suspend"],
      ["POST", "/admin/licenses/l1/reinstate"],
      ["POST", "/admin/licenses/l1/transfer"],
    ]);
  });
});

describe("activationApi client", () => {
  it("exposes the activation registry endpoints at the expected method + path", async () => {
    const fn = mockFetch(200, { activations: [], seatsUsed: 0, seatLimit: 5, id: "a1", status: "deactivated" });
    await activationApi.listActivations("l1");
    await activationApi.reclaim("l1", "a1");
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/licenses/l1/activations"],
      ["POST", "/admin/licenses/l1/activations/a1/deactivate"],
    ]);
  });
});

describe("leaseApi client", () => {
  it("exposes the lease registry + force-release endpoints at the expected method + path", async () => {
    const fn = mockFetch(200, { concurrencyUsed: 0, maxConcurrent: 5, overageAllowance: 0, scope: "session", truncated: false, leases: [], id: "lease-1", status: "reclaimed" });
    await leaseApi.listLeases("l1");
    await leaseApi.listLeases("l1", "live");
    await leaseApi.forceRelease("lease-1");
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/licenses/l1/leases"],
      ["GET", "/admin/licenses/l1/leases?status=live"],
      ["POST", "/admin/leases/lease-1/force-release"],
    ]);
  });
});

describe("billingApi client", () => {
  it("exposes every billing endpoint at the expected method + path", async () => {
    const fn = mockFetch(200, {
      connections: [],
      id: "bc1",
      provider: "stripe",
      status: "active",
      jobId: "job-1",
      scope: "tenant",
    });
    await billingApi.listConnections();
    await billingApi.createConnection({ provider: "stripe", signingSecret: "whsec_x" });
    await billingApi.updateConnection("bc1", { status: "disabled" });
    await billingApi.rotateSecret("bc1", "whsec_new");
    await billingApi.reconcile();
    await billingApi.reconcile({ connectionId: "bc1", subscriptionId: "sub-1" });
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/billing/connections"],
      ["POST", "/admin/billing/connections"],
      ["PATCH", "/admin/billing/connections/bc1"],
      ["POST", "/admin/billing/connections/bc1/rotate-secret"],
      ["POST", "/admin/billing/reconcile"],
      ["POST", "/admin/billing/reconcile"],
    ]);
  });

  it("sends the write-only signing secret only in the create/rotate bodies", async () => {
    const fn = mockFetch(200, { id: "bc1", provider: "stripe", status: "active" });
    await billingApi.createConnection({ provider: "paddle", signingSecret: "whsec_secret" });
    await billingApi.rotateSecret("bc1", "whsec_rotated");
    const createBody = JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string);
    const rotateBody = JSON.parse((fn.mock.calls[1]![1] as RequestInit).body as string);
    expect(createBody.signingSecret).toBe("whsec_secret");
    expect(rotateBody.signingSecret).toBe("whsec_rotated");
  });
});

describe("usageApi client", () => {
  it("serializes the usage query window + options into the query string", async () => {
    const fn = mockFetch(200, {
      licenseId: "l1",
      window: { from: "2026-01-01", to: "2026-02-01", bucket: "day" },
      raw: true,
      entitlements: [],
      truncated: false,
    });
    await usageApi.getUsage("l1", { from: "2026-01-01", to: "2026-02-01" });
    await usageApi.getUsage("l1", {
      from: "2026-01-01",
      to: "2026-02-01",
      entitlementId: "e1",
      bucket: "day",
      raw: true,
    });
    const [firstUrl] = fn.mock.calls[0] as [string];
    const [secondUrl] = fn.mock.calls[1] as [string];
    expect(firstUrl).toBe("/admin/licenses/l1/usage?from=2026-01-01&to=2026-02-01");
    expect(secondUrl).toContain("/admin/licenses/l1/usage?");
    expect(secondUrl).toContain("entitlementId=e1");
    expect(secondUrl).toContain("bucket=day");
    expect(secondUrl).toContain("raw=true");
    expect((fn.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });
});

describe("policyApi client", () => {
  it("exposes every policy endpoint at the expected method + path", async () => {
    const fn = mockFetch(200, {
      rules: [],
      truncated: false,
      ruleKey: "rk1",
      latestVersion: 1,
      status: "active",
      versions: [],
      version: 1,
      targetEntitlementId: "e1",
    });
    await policyApi.listRules();
    await policyApi.listRules({ entitlementId: "e1", status: "active" });
    await policyApi.getRule("rk1");
    await policyApi.createRule({ targetEntitlementId: "e1", priority: 10, condition: {}, effect: {} });
    await policyApi.editRule("rk1", { priority: 20, condition: {}, effect: {} });
    await policyApi.setStatus("rk1", "disabled");
    await policyApi.dryRun("rk1", { licenseId: "l1" });
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/policy/rules"],
      ["GET", "/admin/policy/rules?entitlementId=e1&status=active"],
      ["GET", "/admin/policy/rules/rk1"],
      ["POST", "/admin/policy/rules"],
      ["PATCH", "/admin/policy/rules/rk1"],
      ["POST", "/admin/policy/rules/rk1/status"],
      ["POST", "/admin/policy/rules/rk1/dry-run"],
    ]);
  });
});

describe("resellerApi client", () => {
  it("exposes the operator-plane reseller lifecycle endpoints", async () => {
    const fn = mockFetch(200, {
      resellers: [],
      truncated: false,
      resellerId: "r1",
      displayName: "Acme",
      status: "active",
      subTenantQuota: 10,
      subTenantCount: 0,
      unresolvedSubTenantCount: 0,
      graceEndsAt: "2026-09-01",
      subTenantId: "st1",
    });
    await resellerApi.listResellers();
    await resellerApi.listResellers("suspended");
    await resellerApi.getReseller("r1");
    await resellerApi.onboardReseller({ mode: "create_new", displayName: "Acme", firstAdminUserReference: "u1" });
    await resellerApi.updateQuota("r1", 25);
    await resellerApi.suspendReseller("r1");
    await resellerApi.reinstateReseller("r1");
    await resellerApi.offboardReseller("r1");
    await resellerApi.moveSubTenant("st1", { type: "to_direct_platform" });
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/operator/resellers"],
      ["GET", "/admin/operator/resellers?status=suspended"],
      ["GET", "/admin/operator/resellers/r1"],
      ["POST", "/admin/operator/resellers"],
      ["PATCH", "/admin/operator/resellers/r1/quota"],
      ["POST", "/admin/operator/resellers/r1/suspend"],
      ["POST", "/admin/operator/resellers/r1/reinstate"],
      ["POST", "/admin/operator/resellers/r1/offboard"],
      ["POST", "/admin/operator/sub-tenants/st1/move"],
    ]);
  });

  it("exposes the reseller-plane sub-tenant + branding + domain endpoints", async () => {
    const fn = mockFetch(200, {
      subTenants: [],
      truncated: false,
      subTenantQuota: 10,
      subTenantCount: 0,
      subTenantId: "st1",
      displayName: "Sub",
      status: "active",
      readOnly: false,
      fields: {},
      locked: [],
      resolved: [],
      updatedAt: "2026-01-01",
      bindings: [],
      bindingId: "b1",
      kind: "domain",
      host: "acme.example",
      challenge: "dns=x",
    });
    await resellerApi.listSubTenants();
    await resellerApi.getSubTenant("st1");
    await resellerApi.provisionSubTenant({ displayName: "Sub", firstAdminUserReference: "u1" });
    await resellerApi.getResellerBranding();
    await resellerApi.setResellerBranding({ fields: { productName: "White" }, locked: ["productName"] });
    await resellerApi.listDomains();
    await resellerApi.getDomain("b1");
    await resellerApi.initiateDomain({ kind: "domain", host: "acme.example" });
    await resellerApi.verifyDomain("b1");
    await resellerApi.activateDomain("b1");
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/reseller/sub-tenants"],
      ["GET", "/admin/reseller/sub-tenants/st1"],
      ["POST", "/admin/reseller/sub-tenants"],
      ["GET", "/admin/reseller/branding"],
      ["PUT", "/admin/reseller/branding"],
      ["GET", "/admin/reseller/domains"],
      ["GET", "/admin/reseller/domains/b1"],
      ["POST", "/admin/reseller/domains"],
      ["POST", "/admin/reseller/domains/b1/verify"],
      ["POST", "/admin/reseller/domains/b1/activate"],
    ]);
  });

  it("exposes the sub-tenant-plane own-branding endpoints", async () => {
    const fn = mockFetch(200, { overrides: {}, lockedFields: [], resolved: [], updatedAt: "2026-01-01" });
    await resellerApi.getBranding();
    await resellerApi.setBranding({ productName: "Mine" });
    const calls = fn.mock.calls.map((c) => [(c[1] as RequestInit).method, c[0]]);
    expect(calls).toEqual([
      ["GET", "/admin/branding"],
      ["PUT", "/admin/branding"],
    ]);
    const putBody = JSON.parse((fn.mock.calls[1]![1] as RequestInit).body as string);
    expect(putBody).toEqual({ overrides: { productName: "Mine" } });
  });

  it("promotes an existing tenant via the onboard promote_existing mode", async () => {
    const fn = mockFetch(200, { resellerId: "r2", displayName: "Promo", status: "active", subTenantQuota: 5, subTenantCount: 0 });
    await resellerApi.onboardReseller({ mode: "promote_existing", tenantId: "t9", firstAdminUserReference: "u1", subTenantQuota: 5 });
    const body = JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ mode: "promote_existing", tenantId: "t9" });
  });
});
