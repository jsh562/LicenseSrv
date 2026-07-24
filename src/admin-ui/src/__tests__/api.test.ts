// The API client contract (FR-015/019): cookies ride along, the CSRF token is echoed on mutations,
// non-2xx becomes a typed ApiError, and 204 resolves void. Drives the real client against a mocked
// fetch (this file must NOT mock ../api — it is the unit under test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activationApi, adminApi, ApiError, catalogApi, leaseApi, licensingApi, readCookie } from "../api";

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
