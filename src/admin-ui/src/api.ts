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
