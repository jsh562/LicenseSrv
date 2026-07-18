const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
/**
 * Fail-closed authorization (TR-013/TR-016): an operation is permitted only if the
 * principal's RBAC role meets the minimum AND the API-key scope includes the required
 * scope. Denial by either gate is the auditable security event (SC-007).
 */
export function authorize(principal, policy) {
    if (ROLE_RANK[principal.role] < ROLE_RANK[policy.minRole]) {
        return { allowed: false, reason: "insufficient-role" };
    }
    if (!principal.scopes.includes(policy.requiredScope)) {
        return { allowed: false, reason: "insufficient-scope" };
    }
    return { allowed: true };
}
