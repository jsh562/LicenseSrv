// Operator reseller management (E018, US4; FR-001/003/010/011/012/015). The OPERATOR plane: an admin ONBOARDS a
// reseller (create a new tenant OR promote an existing one, establishing the first reseller-admin + the hard
// sub-tenant quota), LISTS all resellers with their lifecycle status + quota position, adjusts the hard QUOTA
// (operator-only — a reseller can never raise its own), SUSPENDS (a reversible read-only cascade) / REINSTATES,
// OFFBOARDS (blocked until every sub-tenant is transferred/reassigned — 409 sub_tenants_unresolved — then a grace
// window), and MOVES a sub-tenant between resellers or back to direct-platform (audited on both sides). Every
// mutation is admin-only (hidden from a viewer by RequireRole) and rides the double-submit CSRF token; the server
// enforces the operator plane + RBAC + CSRF fail-closed regardless of what the SPA shows. No secret is ever shown.
import { useState, type FormEvent } from "react";

import {
  ApiError,
  resellerApi,
  type Reseller,
  type ResellerStatus,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

/** Map an onboard/lifecycle ApiError to a human message, keeping the DISTINCT 409 codes explainable inline. */
function lifecycleErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "onboarding_conflict":
        return "That tenant is already a reseller or a sub-tenant (only one reseller level is allowed).";
      case "sub_tenants_unresolved":
        return "Offboarding is blocked: transfer or reassign every sub-tenant first.";
      case "invalid_state_transition":
        return "That lifecycle transition is not allowed from the reseller's current status.";
      case "quota_exceeded":
        return "The destination reseller is at its hard sub-tenant quota.";
      case "reseller_suspended":
        return "The source or destination reseller is suspended.";
      case "not_found":
        return "No such reseller / sub-tenant in this workspace.";
      case "forbidden":
        return "This is an operator-only action.";
      case "validation_error":
        return `Invalid request: ${err.message}`;
      default:
        return err.message || "The operation failed.";
    }
  }
  return "The operation failed.";
}

export function Resellers({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [statusFilter, setStatusFilter] = useState<ResellerStatus | "">("");
  const { data, reload, error: loadError } = useAsync(
    () => resellerApi.listResellers(statusFilter || undefined),
    [statusFilter],
  );
  const resellers = data?.resellers ?? [];
  const truncated = data?.truncated ?? false;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Onboard form state.
  const [mode, setMode] = useState<"create_new" | "promote_existing">("create_new");
  const [displayName, setDisplayName] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [firstAdmin, setFirstAdmin] = useState("");
  const [quota, setQuota] = useState("");

  // Move form state.
  const [moveSubTenantId, setMoveSubTenantId] = useState("");
  const [moveDestReseller, setMoveDestReseller] = useState("");

  async function onboard(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const q = quota.trim() === "" ? undefined : Number(quota);
    try {
      const created =
        mode === "create_new"
          ? await resellerApi.onboardReseller({
              mode,
              displayName: displayName.trim(),
              firstAdminUserReference: firstAdmin.trim(),
              subTenantQuota: q,
            })
          : await resellerApi.onboardReseller({
              mode,
              tenantId: tenantId.trim(),
              firstAdminUserReference: firstAdmin.trim(),
              subTenantQuota: q,
            });
      setNotice(`Reseller ${created.displayName} onboarded (quota ${created.subTenantQuota}).`);
      setDisplayName("");
      setTenantId("");
      setFirstAdmin("");
      setQuota("");
      await reload();
    } catch (err) {
      setError(lifecycleErrorMessage(err));
    }
  }

  async function changeQuota(r: Reseller): Promise<void> {
    setError(null);
    setNotice(null);
    const input = window.prompt(`New hard sub-tenant quota for ${r.displayName}:`, String(r.subTenantQuota));
    if (input === null) return;
    const next = Number(input);
    if (!Number.isInteger(next) || next < 0) {
      setError("The quota must be a non-negative integer.");
      return;
    }
    try {
      const updated = await resellerApi.updateQuota(r.resellerId, next);
      setNotice(`Quota for ${updated.displayName} is now ${updated.subTenantQuota}.`);
      await reload();
    } catch (err) {
      setError(lifecycleErrorMessage(err));
    }
  }

  async function lifecycle(r: Reseller, action: "suspend" | "reinstate" | "offboard"): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      if (action === "suspend") {
        const u = await resellerApi.suspendReseller(r.resellerId);
        setNotice(`${u.displayName} suspended (read-only cascade active).`);
      } else if (action === "reinstate") {
        const u = await resellerApi.reinstateReseller(r.resellerId);
        setNotice(`${u.displayName} reinstated.`);
      } else {
        const res = await resellerApi.offboardReseller(r.resellerId);
        setNotice(
          res.unresolvedSubTenantCount > 0
            ? `Offboard blocked: ${res.unresolvedSubTenantCount} sub-tenant(s) still to resolve.`
            : `${r.displayName} offboarding; grace ends ${res.graceEndsAt}.`,
        );
      }
      await reload();
    } catch (err) {
      setError(lifecycleErrorMessage(err));
    }
  }

  async function move(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!moveSubTenantId.trim()) return;
    const destination = moveDestReseller.trim()
      ? ({ type: "to_reseller", destinationResellerId: moveDestReseller.trim() } as const)
      : ({ type: "to_direct_platform" } as const);
    try {
      const moved = await resellerApi.moveSubTenant(moveSubTenantId.trim(), destination);
      setNotice(
        `Sub-tenant ${moved.displayName} moved ${moved.resellerId ? `to reseller ${moved.resellerId}` : "to direct-platform"}.`,
      );
      setMoveSubTenantId("");
      setMoveDestReseller("");
      await reload();
    } catch (err) {
      setError(lifecycleErrorMessage(err));
    }
  }

  return (
    <section aria-label="Resellers" className="space-y-4">
      <PageHeader title="Resellers (operator)" description="Platform-operator view: onboard partners, set their sub-tenant quota, suspend/reinstate/offboard, and move sub-tenants." />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load resellers."}
        </p>
      )}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={onboard} aria-label="Onboard reseller" className="flex flex-wrap items-end gap-3">
            <Select aria-label="Onboard mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="w-56">
              <option value="create_new">create new tenant</option>
              <option value="promote_existing">promote existing tenant</option>
            </Select>
            {mode === "create_new" ? (
              <Input
                aria-label="Display name"
                placeholder="reseller display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-56"
              />
            ) : (
              <Input
                aria-label="Tenant id"
                placeholder="tenant uuid to promote"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-56"
              />
            )}
            <Input
              aria-label="First admin reference"
              placeholder="first reseller-admin reference"
              value={firstAdmin}
              onChange={(e) => setFirstAdmin(e.target.value)}
              required
              className="w-56"
            />
            <Input
              aria-label="Sub-tenant quota"
              type="number"
              min={0}
              placeholder="quota (default)"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              className="w-40"
            />
            <Button type="submit">Onboard reseller</Button>
          </form>
        </Card>
      </RequireRole>

      <label className="inline-flex items-center gap-2 text-sm font-medium">
        Filter status
        <Select
          aria-label="Filter reseller status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ResellerStatus | "")}
          className="w-40"
        >
          <option value="">all</option>
          <option value="active">active</option>
          <option value="suspended">suspended</option>
          <option value="offboarding">offboarding</option>
        </Select>
      </label>

      {truncated && <p role="status" className="text-sm text-fg-muted">Showing the first 1000 resellers (list truncated).</p>}
      {resellers.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">No resellers yet.</p>
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Reseller</Th><Th>Status</Th><Th>Sub-tenants</Th><Th>Quota</Th><Th>Actions</Th>
            </Tr>
          </THead>
          <TBody>
            {resellers.map((r) => (
              <Tr key={r.resellerId}>
                <Td>{r.displayName}</Td>
                <Td><Badge tone={statusTone(r.status)}>{r.status}</Badge></Td>
                <Td>{r.subTenantCount}</Td>
                <Td>{r.subTenantQuota}</Td>
                <Td>
                  <RequireRole role={sessionRole} min="admin">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="sm" type="button" aria-label={`Set quota ${r.displayName}`} onClick={() => void changeQuota(r)}>Quota</Button>
                      <Button variant="secondary" size="sm" type="button" aria-label={`Suspend ${r.displayName}`} onClick={() => void lifecycle(r, "suspend")}>Suspend</Button>
                      <Button variant="secondary" size="sm" type="button" aria-label={`Reinstate ${r.displayName}`} onClick={() => void lifecycle(r, "reinstate")}>Reinstate</Button>
                      <Button variant="danger" size="sm" type="button" aria-label={`Offboard ${r.displayName}`} onClick={() => void lifecycle(r, "offboard")}>Offboard</Button>
                    </div>
                  </RequireRole>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={move} aria-label="Move sub-tenant" className="space-y-3">
            <h4 className="font-medium">Move a sub-tenant</h4>
            <div className="flex flex-wrap items-end gap-3">
              <Input
                aria-label="Move sub-tenant id"
                placeholder="sub-tenant uuid"
                value={moveSubTenantId}
                onChange={(e) => setMoveSubTenantId(e.target.value)}
                className="w-64"
              />
              <Input
                aria-label="Destination reseller id"
                placeholder="destination reseller uuid (blank = direct-platform)"
                value={moveDestReseller}
                onChange={(e) => setMoveDestReseller(e.target.value)}
                className="w-80"
              />
              <Button type="submit">Move</Button>
            </div>
          </form>
        </Card>
      </RequireRole>
    </section>
  );
}
