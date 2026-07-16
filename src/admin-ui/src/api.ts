// Typed admin API client (FR-015, AD-007). Same-origin fetch with `credentials: "include"` so the
// httpOnly session cookie rides along; the readable CSRF cookie is echoed in X-CSRF-Token on every
// mutating call (the double-submit the server enforces). Bodies are camelCase both ways. A non-2xx
// response becomes a typed ApiError carrying the server's { code, message } so views can branch on it.
export type Role = "owner" | "admin" | "viewer";
export type Scope = "activate" | "validate" | "admin";
export type UserStatus = "invited" | "active" | "deactivated";

export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
}
export interface LoginResult {
  userId: string;
  role: Role;
  expiresAt: string;
}
export interface UserRow {
  id: string;
  status: UserStatus;
  role: Role;
  createdAt: string;
}
export interface ApiKeyMeta {
  id: string;
  scopes: Scope[];
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}
export interface NewApiKey {
  id: string;
  secret: string;
  scopes: Scope[];
}
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  securityEvent: boolean;
  ts: string;
}
export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}
export interface AuditQuery {
  from?: string;
  to?: string;
  securityEvent?: boolean;
  actor?: string;
  cursor?: string;
  limit?: number;
}

/** A typed non-2xx response. `code` mirrors the server's error code (e.g. "invalid_credentials"). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Read a cookie value by name from document.cookie (the CSRF token is JS-readable by design). */
export function readCookie(name: string): string | undefined {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (MUTATING.has(method)) {
    const csrf = readCookie("admin_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (data ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, e.code ?? "error", e.message ?? res.statusText);
  }
  return data as T;
}

function qs(query: AuditQuery): string {
  const p = new URLSearchParams();
  if (query.from) p.set("from", query.from);
  if (query.to) p.set("to", query.to);
  if (query.securityEvent) p.set("securityEvent", "true");
  if (query.actor) p.set("actor", query.actor);
  if (query.cursor) p.set("cursor", query.cursor);
  if (query.limit) p.set("limit", String(query.limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The admin console API surface (mirrors src/server/modules/admin/routes.ts). */
export const adminApi = {
  login: (tenantSlug: string, email: string, password: string) =>
    request<LoginResult>("POST", "/admin/auth/login", { tenantSlug, email, password }),
  me: () => request<Principal>("GET", "/admin/auth/me"),
  logout: () => request<void>("POST", "/admin/auth/logout"),

  listUsers: () => request<{ users: UserRow[] }>("GET", "/admin/users").then((r) => r.users),
  createUser: (input: { email: string; role: Role; password?: string }) =>
    request<{ id: string; status: UserStatus }>("POST", "/admin/users", input),
  updateUser: (userId: string, input: { role?: Role; status?: "active" | "deactivated" }) =>
    request<{ id: string; role: Role; status: UserStatus }>("PATCH", `/admin/users/${userId}`, input),

  listApiKeys: () => request<{ keys: ApiKeyMeta[] }>("GET", "/admin/api-keys").then((r) => r.keys),
  createApiKey: (scopes: Scope[]) => request<NewApiKey>("POST", "/admin/api-keys", { scopes }),
  rotateApiKey: (keyId: string) => request<NewApiKey>("POST", `/admin/api-keys/${keyId}/rotate`),
  revokeApiKey: (keyId: string) =>
    request<{ id: string; status: string }>("POST", `/admin/api-keys/${keyId}/revoke`),

  listAudit: (query: AuditQuery = {}) => request<AuditPage>("GET", `/admin/audit${qs(query)}`),
};

export type AdminApi = typeof adminApi;

// --- Catalog (E007) -------------------------------------------------------------------------------

export type CatalogStatus = "active" | "archived";
export type EntitlementType = "boolean" | "integer_limit";
export type StatusFilter = "active" | "archived" | "all";

export interface Product {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
}
export interface Plan {
  id: string;
  productId: string;
  key: string;
  name: string;
  description: string | null;
  maxActivations: number;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
}
export interface Entitlement {
  id: string;
  key: string;
  name: string;
  type: EntitlementType;
  description: string | null;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
}
export interface PlanEntitlementValue {
  entitlementId: string;
  key: string;
  type: EntitlementType;
  value: boolean | number;
}
export interface EffectivePlanDefinition {
  planKey: string;
  productKey: string;
  maxActivations: number;
  entitlements: Array<{ key: string; type: EntitlementType; value: boolean | number }>;
}

function statusQs(status?: StatusFilter): string {
  return status ? `?status=${status}` : "";
}

/** The catalog API surface (mirrors src/server/modules/catalog/routes.ts). */
export const catalogApi = {
  listProducts: (status?: StatusFilter) =>
    request<{ products: Product[] }>("GET", `/admin/catalog/products${statusQs(status)}`).then((r) => r.products),
  createProduct: (input: { key: string; name: string; description?: string }) =>
    request<Product>("POST", "/admin/catalog/products", input),
  archiveProduct: (id: string) => request<Product>("POST", `/admin/catalog/products/${id}/archive`),

  listPlans: (productId: string, status?: StatusFilter) =>
    request<{ plans: Plan[] }>("GET", `/admin/catalog/products/${productId}/plans${statusQs(status)}`).then((r) => r.plans),
  createPlan: (productId: string, input: { key: string; name: string; description?: string; maxActivations?: number }) =>
    request<Plan>("POST", `/admin/catalog/products/${productId}/plans`, input),
  archivePlan: (id: string) => request<Plan>("POST", `/admin/catalog/plans/${id}/archive`),

  listEntitlements: (status?: StatusFilter) =>
    request<{ entitlements: Entitlement[] }>("GET", `/admin/catalog/entitlements${statusQs(status)}`).then((r) => r.entitlements),
  createEntitlement: (input: { key: string; name: string; type: EntitlementType; description?: string }) =>
    request<Entitlement>("POST", "/admin/catalog/entitlements", input),
  archiveEntitlement: (id: string) => request<Entitlement>("POST", `/admin/catalog/entitlements/${id}/archive`),

  listPlanEntitlements: (planId: string) =>
    request<{ entitlements: PlanEntitlementValue[] }>("GET", `/admin/catalog/plans/${planId}/entitlements`).then((r) => r.entitlements),
  setPlanValue: (planId: string, entitlementId: string, value: boolean | number) =>
    request<PlanEntitlementValue>("PUT", `/admin/catalog/plans/${planId}/entitlements/${entitlementId}`, { value }),
  removePlanValue: (planId: string, entitlementId: string) =>
    request<void>("DELETE", `/admin/catalog/plans/${planId}/entitlements/${entitlementId}`),

  // The effective plan definition — the read model E008 issuance consumes.
  getEffective: (planId: string) =>
    request<EffectivePlanDefinition>("GET", `/admin/catalog/plans/${planId}/effective`),
};

export type CatalogApi = typeof catalogApi;

// --- Licensing (E008) -----------------------------------------------------------------------------

export type LicenseStatus = "active" | "suspended" | "revoked";
export type CustomerStatus = "active" | "anonymized";

export interface Customer {
  id: string;
  ref: string;
  name: string | null;
  email: string | null;
  status: CustomerStatus;
  createdAt: string;
}
export interface License {
  id: string;
  productId: string;
  planId: string;
  customerId: string;
  status: LicenseStatus;
  issuedAt: string;
  expiresAt: string | null;
  maxActivations: number;
  entitlements: Record<string, boolean | number>;
  keyId: string | null;
  transferCount: number;
}
export interface IssuedLicense extends License {
  /** The signed LIC1 token — returned only on issue + the /key read; never the signing key. */
  licenseKey: string;
}
export interface LicenseFilters {
  status?: LicenseStatus;
  customerId?: string;
  planId?: string;
}

function licenseQs(f: LicenseFilters): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.customerId) p.set("customerId", f.customerId);
  if (f.planId) p.set("planId", f.planId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The licensing API surface (mirrors src/server/modules/issuance/routes.ts). */
export const licensingApi = {
  listCustomers: () =>
    request<{ customers: Customer[] }>("GET", "/admin/customers").then((r) => r.customers),
  createCustomer: (input: { ref: string; name?: string; email?: string }) =>
    request<Customer>("POST", "/admin/customers", input),
  getCustomer: (id: string) => request<Customer>("GET", `/admin/customers/${id}`),
  eraseCustomer: (id: string) => request<void>("DELETE", `/admin/customers/${id}`),

  issueLicense: (input: { planId: string; customerId: string; expiresAt?: string | null }) =>
    request<IssuedLicense>("POST", "/admin/licenses", input),
  listLicenses: (filters: LicenseFilters = {}) =>
    request<{ licenses: License[] }>("GET", `/admin/licenses${licenseQs(filters)}`).then((r) => r.licenses),
  getLicense: (id: string) => request<License>("GET", `/admin/licenses/${id}`),
  getLicenseKey: (id: string) =>
    request<{ licenseKey: string }>("GET", `/admin/licenses/${id}/key`).then((r) => r.licenseKey),

  revokeLicense: (id: string) => request<License>("POST", `/admin/licenses/${id}/revoke`),
  suspendLicense: (id: string) => request<License>("POST", `/admin/licenses/${id}/suspend`),
  reinstateLicense: (id: string) => request<License>("POST", `/admin/licenses/${id}/reinstate`),
  transferLicense: (id: string, customerId: string) =>
    request<License>("POST", `/admin/licenses/${id}/transfer`, { customerId }),
};

export type LicensingApi = typeof licensingApi;

// --- Activation registry (E009) -------------------------------------------------------------------

export type ActivationStatus = "active" | "deactivated";

export interface Activation {
  id: string;
  machineId: string;
  status: ActivationStatus;
  activatedAt: string;
  deactivatedAt: string | null;
  label: string | null;
}
export interface ActivationRegistry {
  activations: Activation[];
  seatsUsed: number;
  seatLimit: number;
}

/** The console's view of the activation registry (mirrors the /admin side of activation routes.ts). The
 * runtime /v1 activate/deactivate is called by the licensed app/SDK, not the console — so it is not here. */
export const activationApi = {
  listActivations: (licenseId: string) =>
    request<ActivationRegistry>("GET", `/admin/licenses/${licenseId}/activations`),
  reclaim: (licenseId: string, activationId: string) =>
    request<{ id: string; status: ActivationStatus }>("POST", `/admin/licenses/${licenseId}/activations/${activationId}/deactivate`),
};

export type ActivationApi = typeof activationApi;
