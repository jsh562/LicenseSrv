// Reseller sub-tenant management (E018, US1; FR-002/003/004/017). The RESELLER plane: a reseller-admin LISTS its
// own sub-tenants (METADATA-ONLY — id / display name / status / read-only-cascade / created-at; NEVER any
// license, usage, or activation data, FR-017) alongside its quota position, and PROVISIONS a new sub-tenant under
// the HARD quota (409 quota_exceeded at the cap). Provisioning is admin-only (hidden from a viewer by
// RequireRole) and rides the double-submit CSRF token; the server enforces the reseller plane + subtree gate +
// RBAC + CSRF fail-closed, and an out-of-subtree id resolves 404 with no existence disclosure. No secret is shown.
import { useState, type FormEvent } from "react";

import { ApiError, resellerApi, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

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
  const { data, reload, error: loadError } = useAsync(() => resellerApi.listSubTenants(), []);
  const subTenants = data?.subTenants ?? [];
  const truncated = data?.truncated ?? false;
  const quota = data ? { used: data.subTenantCount, cap: data.subTenantQuota } : null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [firstAdmin, setFirstAdmin] = useState("");

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
      await reload();
    } catch (err) {
      setError(provisionErrorMessage(err));
    }
  }

  const atCap = quota !== null && quota.used >= quota.cap;

  return (
    <section aria-label="Sub-tenants" className="space-y-4">
      <PageHeader title="My sub-tenants" />
      {quota && (
        <p role="status" className="text-sm text-fg-muted">{`Using ${quota.used} of ${quota.cap} sub-tenants${atCap ? " (at hard quota)" : ""}.`}</p>
      )}
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load sub-tenants."}
        </p>
      )}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={provision} aria-label="Provision sub-tenant" className="flex flex-wrap items-end gap-3">
            <Input
              aria-label="Sub-tenant display name"
              placeholder="customer display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-56"
            />
            <Input
              aria-label="Sub-tenant first admin reference"
              placeholder="first admin reference"
              value={firstAdmin}
              onChange={(e) => setFirstAdmin(e.target.value)}
              className="w-56"
            />
            <Button type="submit" disabled={atCap}>Provision sub-tenant</Button>
          </form>
        </Card>
      </RequireRole>

      {truncated && <p role="status" className="text-sm text-fg-muted">Showing the first 1000 sub-tenants (list truncated).</p>}
      {subTenants.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">No sub-tenants yet.</p>
      ) : (
        <Table>
          <THead>
            <Tr><Th>Sub-tenant</Th><Th>Status</Th><Th>Access</Th><Th>Created</Th></Tr>
          </THead>
          <TBody>
            {subTenants.map((s) => (
              <Tr key={s.subTenantId}>
                <Td>{s.displayName}</Td>
                <Td><Badge tone={statusTone(s.status)}>{s.status}</Badge></Td>
                <Td>{s.readOnly ? "read-only" : "read-write"}</Td>
                <Td>{s.createdAt}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
