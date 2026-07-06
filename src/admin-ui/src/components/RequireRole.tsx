// Client-side role gate (US2, FR-015, SC-010). Renders its children only when the session's role meets
// `min`. This is a UX affordance — hiding actions a viewer can't perform — NOT the security boundary:
// the server enforces RBAC fail-closed on every route regardless of what the SPA shows.
import type { ReactNode } from "react";

import type { Role } from "../api";

const RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

/** True iff `role` is at least `min` in the owner > admin > viewer ordering. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function RequireRole({
  role,
  min,
  children,
}: {
  role: Role;
  min: Role;
  children: ReactNode;
}): JSX.Element | null {
  return roleAtLeast(role, min) ? <>{children}</> : null;
}
