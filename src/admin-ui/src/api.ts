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
/** The entitlement kind, extended with the additive E016 `metered` kind (FR-008). */
export type EntitlementKind = EntitlementType | "metered";
/** The counter-only metered aggregation set (E016 FR-008). */
export type MeteredAggregation = "sum" | "count" | "unique_count";
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
  type: EntitlementKind;
  description: string | null;
  status: CatalogStatus;
  /** Metered-only (FR-008): the aggregation type; null for boolean/integer_limit. */
  aggregation?: MeteredAggregation | null;
  /** Metered-only: the unit label; null for non-metered. */
  unit?: string | null;
  /** Metered-only: the optional allowance/quota (signal-only); null = no quota / non-metered. */
  allowance?: number | null;
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
  createEntitlement: (input: {
    key: string;
    name: string;
    type: EntitlementKind;
    description?: string;
    aggregation?: MeteredAggregation;
    unit?: string;
    allowance?: number;
  }) => request<Entitlement>("POST", "/admin/catalog/entitlements", input),
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

// --- Billing (E014) -------------------------------------------------------------------------------

export type BillingProvider = "stripe" | "paddle" | "generic";
export type ConnectionStatus = "active" | "disabled";

/** A provider-plan → E007-catalog mapping value. */
export interface PlanMapping {
  productId: string;
  planId: string;
}
export type PlanMap = Record<string, PlanMapping>;

/**
 * The secret-EXCLUDING connection read model (the `billing_connection_public` view). The inbound webhook
 * signing secret is WRITE-ONLY and is NEVER present here — it is never returned by any API (FR-015).
 */
export interface BillingConnection {
  id: string;
  provider: BillingProvider;
  status: ConnectionStatus;
  secretCustodyScheme: string;
  secretRotatedAt: string | null;
  planMap: PlanMap;
  defaultGraceSeconds: number;
  graceOverrides: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionInput {
  provider: BillingProvider;
  /** WRITE-ONLY: sent on create, never returned. */
  signingSecret: string;
  planMap?: PlanMap;
  defaultGraceSeconds?: number;
  graceOverrides?: Record<string, number>;
}

export interface UpdateConnectionInput {
  status?: ConnectionStatus;
  planMap?: PlanMap;
  defaultGraceSeconds?: number;
  graceOverrides?: Record<string, number>;
}

export interface ReconcileAccepted {
  jobId: string;
  status: "accepted";
  scope: "tenant" | "connection" | "subscription";
}

/** The billing API surface (mirrors src/server/modules/billing/routes.ts admin plane). Secret is write-only. */
export const billingApi = {
  listConnections: () =>
    request<{ connections: BillingConnection[] }>("GET", "/admin/billing/connections").then((r) => r.connections),
  createConnection: (input: CreateConnectionInput) =>
    request<BillingConnection>("POST", "/admin/billing/connections", input),
  updateConnection: (id: string, input: UpdateConnectionInput) =>
    request<BillingConnection>("PATCH", `/admin/billing/connections/${id}`, input),
  // The new secret is write-only; the response is the secret-excluding projection.
  rotateSecret: (id: string, signingSecret: string) =>
    request<BillingConnection>("POST", `/admin/billing/connections/${id}/rotate-secret`, { signingSecret }),
  reconcile: (scope: { connectionId?: string; subscriptionId?: string } = {}) =>
    request<ReconcileAccepted>("POST", "/admin/billing/reconcile", scope),
};

export type BillingApi = typeof billingApi;

// --- Leases / Concurrency (E015) ------------------------------------------------------------------

export type ConcurrencyScope = "session" | "machine" | "user";
export type LeaseState = "live" | "released" | "reclaimed";

/**
 * One lease as shown in the admin registry — pseudonymous and read-only. The signed lease handle and any raw
 * holder reference are NEVER returned here; only the pseudonymous `holderKey` (a salted hash) is exposed.
 */
export interface LeaseSummary {
  id: string;
  holderKey: string;
  scope: ConcurrencyScope;
  status: LeaseState;
  acquiredAt: string;
  lastRenewedAt: string;
  expiresAt: string;
}

/** A license's lease registry — the lease list plus a concurrency-used-vs-cap summary (bounded + truncated). */
export interface LeaseRegistry {
  concurrencyUsed: number;
  maxConcurrent: number | null;
  overageAllowance: number;
  scope: ConcurrencyScope;
  truncated: boolean;
  leases: LeaseSummary[];
}

export interface ForceReleaseResult {
  id: string;
  status: "reclaimed";
}

function leaseStatusQs(status?: LeaseState): string {
  return status ? `?status=${status}` : "";
}

/**
 * The lease (Concurrency) API surface (mirrors the /admin plane of src/server/modules/lease/routes.ts). The
 * runtime /v1 acquire/renew/release is called by the licensed app (API key), NOT the console — so it is not
 * here. Admin force-release is a mutation: the CSRF token rides along automatically.
 */
export const leaseApi = {
  listLeases: (licenseId: string, status?: LeaseState) =>
    request<LeaseRegistry>("GET", `/admin/licenses/${licenseId}/leases${leaseStatusQs(status)}`),
  forceRelease: (leaseId: string) =>
    request<ForceReleaseResult>("POST", `/admin/leases/${leaseId}/force-release`),
};

export type LeaseApi = typeof leaseApi;

// --- Usage metering (E016) ------------------------------------------------------------------------

export type UsageAggregation = "sum" | "count" | "unique_count";
export type UsageBucketGrouping = "hour" | "day" | "period";

/** One time-bucket of an entitlement's usage (present only when a bucket grouping is requested). */
export interface UsageBucket {
  bucketStart: string;
  value: number;
}

/**
 * The aggregated usage for one metered entitlement over the window. `value` is FLOORED at zero for display
 * unless `raw=true` (admin+), in which case it is the TRUE signed net consumed by billing true-up (E014).
 */
export interface UsageEntitlementAggregate {
  entitlementId: string;
  aggregation: UsageAggregation;
  unit: string;
  value: number;
  allowance: number | null;
  overQuota: boolean;
  buckets?: UsageBucket[];
}

/** A license's aggregated usage over a window (reproducible + self-describing). */
export interface UsageQueryResult {
  licenseId: string;
  window: { from: string; to: string; bucket: UsageBucketGrouping | null };
  raw: boolean;
  entitlements: UsageEntitlementAggregate[];
  truncated: boolean;
}

export interface UsageQuery {
  from: string;
  to: string;
  entitlementId?: string;
  bucket?: UsageBucketGrouping;
  /** Request the TRUE signed net (admin+ only; a viewer requesting it is refused 403). */
  raw?: boolean;
}

function usageQs(q: UsageQuery): string {
  const p = new URLSearchParams();
  p.set("from", q.from);
  p.set("to", q.to);
  if (q.entitlementId) p.set("entitlementId", q.entitlementId);
  if (q.bucket) p.set("bucket", q.bucket);
  if (q.raw) p.set("raw", "true");
  return `?${p.toString()}`;
}

/**
 * The usage-metering query API surface (mirrors the /admin plane of src/server/modules/usage/routes.ts). The
 * runtime /v1/usage ingest is called by the licensed app (API key), NOT the console — so it is not here. The
 * query is a GET (read); `raw=true` returns the true signed net and requires the admin role server-side.
 */
export const usageApi = {
  getUsage: (licenseId: string, query: UsageQuery) =>
    request<UsageQueryResult>("GET", `/admin/licenses/${licenseId}/usage${usageQs(query)}`),
};

export type UsageApi = typeof usageApi;

// --- Low-code policy rules (E017) -----------------------------------------------------------------

/** A rule's lifecycle status: only an `active` head enforces; `preview` logs report-only; `disabled` is idle. */
export type PolicyRuleStatus = "active" | "preview" | "disabled";
/** The closed typed effect kinds (AD-002): a bounded limit adjust, a rule-eligible toggle, or a plan-tier select. */
export type PolicyEffectKind = "adjust_limit" | "toggle_boolean" | "select_tier";

/** A structured-JSON `when` condition (an allow-listed JSONLogic subset — NOT free-form code). */
export type PolicyCondition = Record<string, unknown>;
/** A closed typed effect descriptor `{kind, target?, value}` the trusted server-side applier bounds/applies. */
export type PolicyEffect = Record<string, unknown>;

/**
 * A non-blocking author-time lint finding (FR-006, SC-010) — an overlapping/unreachable/shadowed peer. A warning
 * is surfaced on the create/edit response but never blocks the persist.
 */
export interface PolicyLintWarning {
  code: string;
  message: string;
  ruleKey: string;
  version: number;
  priority: number;
}

/** One IMMUTABLE rule version (contract `PolicyRuleVersion`). `description` is accepted on the wire but not stored. */
export interface PolicyRuleVersion {
  ruleKey: string;
  version: number;
  targetEntitlementId: string;
  description: string | null;
  priority: number;
  status: PolicyRuleStatus;
  condition: PolicyCondition;
  effect: PolicyEffect;
  author: string;
  createdAt: string;
  /** Present on a create/edit response: the non-blocking author-time overlap/unreachable lint findings. */
  warnings?: PolicyLintWarning[];
}

/** A latest-version summary of one logical rule (contract `PolicyRuleSummary`). */
export interface PolicyRuleSummary {
  ruleKey: string;
  latestVersion: number;
  targetEntitlementId: string;
  description: string | null;
  priority: number;
  status: PolicyRuleStatus;
  effectKind?: PolicyEffectKind;
  updatedAt: string;
}

/** The bounded, deterministic rule list + a `truncated` signal when the tenant has more than the page cap. */
export interface PolicyRuleList {
  rules: PolicyRuleSummary[];
  truncated: boolean;
}

/** A rule head + its FULL immutable version history (contract `PolicyRuleDetail`). */
export interface PolicyRuleDetail {
  ruleKey: string;
  latestVersion: number;
  status: PolicyRuleStatus;
  versions: PolicyRuleVersion[];
}

/** The would-be decision a dry-run resolves (non-enforcing). */
export interface DryRunDecision {
  targetEntitlementId: string;
  target: string;
  effectKind: PolicyEffectKind | null;
  baseValue: number | boolean | null;
  resolvedValue: number | boolean | null;
  authoredMaximum: number | null;
  clamped: boolean;
  source: "rule" | "base";
}

/** A rule considered in the highest-priority-wins scan but NOT applied (with the reason). */
export interface ConsideredRule {
  ruleKey: string;
  version: number;
  reason: string;
}

/** The dry-run/simulate result (contract `DryRunResult`) — mode-marked `dry_run`, non-enforcing (INV-9). */
export interface DryRunResult {
  mode: "dry_run";
  decisionTimestamp: string;
  decision: DryRunDecision;
  firedRule: { ruleKey: string; version: number } | null;
  consideredNotApplied: ConsideredRule[];
}

/** The create/author-a-rule request body (structured-JSON condition + typed effect + priority + target). */
export interface CreatePolicyRuleInput {
  targetEntitlementId: string;
  description?: string;
  priority: number;
  status?: PolicyRuleStatus;
  condition: PolicyCondition;
  effect: PolicyEffect;
}
/** The edit request body — an edit creates a NEW immutable version (content columns are immutable). */
export interface EditPolicyRuleInput {
  description?: string;
  priority: number;
  condition: PolicyCondition;
  effect: PolicyEffect;
}
/** A dry-run request: EXACTLY ONE of `context` (a supplied sample) or `licenseId` (a real assembled context). */
export interface DryRunInput {
  context?: Record<string, unknown>;
  licenseId?: string;
  /** An OPTIONAL unsaved candidate rule to simulate in place of the persisted content (validated author-time). */
  candidate?: EditPolicyRuleInput;
}

export interface PolicyRuleFilters {
  entitlementId?: string;
  status?: PolicyRuleStatus;
}

function policyListQs(f: PolicyRuleFilters): string {
  const p = new URLSearchParams();
  if (f.entitlementId) p.set("entitlementId", f.entitlementId);
  if (f.status) p.set("status", f.status);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * The low-code policy-rule API surface (mirrors the /admin plane of src/server/modules/policy/routes.ts). ONE
 * admin plane: viewer reads (list/detail); admin authors/edits/status/dry-run. There is NO runtime/API-key plane
 * — evaluation is an internal issuance-path seam, so the console never triggers a live decision here. Every
 * mutation rides the double-submit CSRF token automatically.
 */
export const policyApi = {
  listRules: (filters: PolicyRuleFilters = {}) =>
    request<PolicyRuleList>("GET", `/admin/policy/rules${policyListQs(filters)}`),
  getRule: (ruleKey: string) => request<PolicyRuleDetail>("GET", `/admin/policy/rules/${ruleKey}`),
  createRule: (input: CreatePolicyRuleInput) => request<PolicyRuleVersion>("POST", "/admin/policy/rules", input),
  editRule: (ruleKey: string, input: EditPolicyRuleInput) =>
    request<PolicyRuleVersion>("PATCH", `/admin/policy/rules/${ruleKey}`, input),
  setStatus: (ruleKey: string, status: PolicyRuleStatus) =>
    request<PolicyRuleSummary>("POST", `/admin/policy/rules/${ruleKey}/status`, { status }),
  dryRun: (ruleKey: string, input: DryRunInput) =>
    request<DryRunResult>("POST", `/admin/policy/rules/${ruleKey}/dry-run`, input),
};

export type PolicyApi = typeof policyApi;
