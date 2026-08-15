// Reseller sub-tenant management (E018, US1; FR-002/003/004/017). The RESELLER plane: a reseller-admin LISTS its
// own sub-tenants (METADATA-ONLY — id / display name / status / read-only-cascade / created-at; NEVER any
// license, usage, or activation data, FR-017) alongside its quota position, and PROVISIONS a new sub-tenant under
// the HARD quota (409 quota_exceeded at the cap). Provisioning is admin-only (hidden from a viewer by
// RequireRole) and rides the double-submit CSRF token; the server enforces the reseller plane + subtree gate +
// RBAC + CSRF fail-closed, and an out-of-subtree id resolves 404 with no existence disclosure. No secret is shown.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, resellerApi, type Role, type SubTenant } from "../../api";
import { RequireRole } from "../../components/RequireRole";

/** Map a provision ApiError to a human message, keeping the hard-quota 409 explainable inline. */
function provisionErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "quota_exceeded":
        return "You have reached your hard sub-tenant quota. Ask the operator to raise it.";
      case "reseller_suspended":
        return "Your reseller account is suspended (read-only). Provisioning is blocked.";
      case "forbidden":
        return "Provisioning requires the admin role on a reseller account.";
      case "validation_error":
        return `Invalid request: ${err.message}`;
      default:
        return err.message || "Could not provision the sub-tenant.";
    }
  }
  return "Could not provision the sub-tenant.";
}

export function SubTenants({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [subTenants, setSubTenants] = useState<SubTenant[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [quota, setQuota] = useState<{ used: number; cap: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [firstAdmin, setFirstAdmin] = useState("");

  const refresh = useCallback(async () => {
    const res = await resellerApi.listSubTenants();
    setSubTenants(res.subTenants);
    setTruncated(res.truncated);
    setQuota({ used: res.subTenantCount, cap: res.subTenantQuota });
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load sub-tenants."));
  }, [refresh]);

  async function provision(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!displayName.trim() || !firstAdmin.trim()) return;
    try {
      const created = await resellerApi.provisionSubTenant({
        displayName: displayName.trim(),
        firstAdminUserReference: firstAdmin.trim(),
      });
      setNotice(`Sub-tenant ${created.displayName} provisioned.`);
      setDisplayName("");
      setFirstAdmin("");
      await refresh();
    } catch (err) {
      setError(provisionErrorMessage(err));
    }
  }

  const atCap = quota !== null && quota.used >= quota.cap;

  return (
    <section aria-label="Sub-tenants">
      <h3>My sub-tenants</h3>
      {quota && (
        <p role="status">{`Using ${quota.used} of ${quota.cap} sub-tenants${atCap ? " (at hard quota)" : ""}.`}</p>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={provision} aria-label="Provision sub-tenant">
          <input
            aria-label="Sub-tenant display name"
            placeholder="customer display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            aria-label="Sub-tenant first admin reference"
            placeholder="first admin reference"
            value={firstAdmin}
            onChange={(e) => setFirstAdmin(e.target.value)}
          />
          <button type="submit" disabled={atCap}>Provision sub-tenant</button>
        </form>
      </RequireRole>

      {truncated && <p role="status">Showing the first 1000 sub-tenants (list truncated).</p>}
      {subTenants.length === 0 ? (
        <p role="status">No sub-tenants yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Sub-tenant</th><th>Status</th><th>Access</th><th>Created</th></tr>
          </thead>
          <tbody>
            {subTenants.map((s) => (
              <tr key={s.subTenantId}>
                <td>{s.displayName}</td>
                <td>{s.status}</td>
                <td>{s.readOnly ? "read-only" : "read-write"}</td>
                <td>{s.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
