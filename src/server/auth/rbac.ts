export type Role = "owner" | "admin" | "viewer";
export type Scope = "activate" | "validate" | "admin";

const ROLE_RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

export interface OperationPolicy {
  minRole: Role;
  requiredScope: Scope;
}

export interface Principal {
  role: Role;
  scopes: string[];
}

export interface AuthDecision {
  allowed: boolean;
  reason?: "insufficient-role" | "insufficient-scope";
}

/**
 * Fail-closed authorization (TR-013/TR-016): an operation is permitted only if the
 * principal's RBAC role meets the minimum AND the API-key scope includes the required
 * scope. Denial by either gate is the auditable security event (SC-007).
 */
export function authorize(principal: Principal, policy: OperationPolicy): AuthDecision {
  if (ROLE_RANK[principal.role] < ROLE_RANK[policy.minRole]) {
    return { allowed: false, reason: "insufficient-role" };
  }
  if (!principal.scopes.includes(policy.requiredScope)) {
    return { allowed: false, reason: "insufficient-scope" };
  }
  return { allowed: true };
}
