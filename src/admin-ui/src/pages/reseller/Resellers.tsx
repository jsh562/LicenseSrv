// Operator reseller management (E018, US4; FR-001/003/010/011/012/015). The OPERATOR plane: an admin ONBOARDS a
// reseller (create a new tenant OR promote an existing one, establishing the first reseller-admin + the hard
// sub-tenant quota), LISTS all resellers with their lifecycle status + quota position, adjusts the hard QUOTA
// (operator-only — a reseller can never raise its own), SUSPENDS (a reversible read-only cascade) / REINSTATES,
// OFFBOARDS (blocked until every sub-tenant is transferred/reassigned — 409 sub_tenants_unresolved — then a grace
// window), and MOVES a sub-tenant between resellers or back to direct-platform (audited on both sides). Every
// mutation is admin-only (hidden from a viewer by RequireRole) and rides the double-submit CSRF token; the server
// enforces the operator plane + RBAC + CSRF fail-closed regardless of what the SPA shows. No secret is ever shown.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  resellerApi,
  type Reseller,
  type ResellerStatus,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";

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
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ResellerStatus | "">("");
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

  const refresh = useCallback(async () => {
    const res = await resellerApi.listResellers(statusFilter || undefined);
    setResellers(res.resellers);
    setTruncated(res.truncated);
  }, [statusFilter]);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load resellers."));
  }, [refresh]);

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
      await refresh();
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
      await refresh();
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
      await refresh();
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
      await refresh();
    } catch (err) {
      setError(lifecycleErrorMessage(err));
    }
  }

  return (
    <section aria-label="Resellers">
      <h3>Resellers (operator)</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={onboard} aria-label="Onboard reseller">
          <select aria-label="Onboard mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="create_new">create new tenant</option>
            <option value="promote_existing">promote existing tenant</option>
          </select>
          {mode === "create_new" ? (
            <input
              aria-label="Display name"
              placeholder="reseller display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          ) : (
            <input
              aria-label="Tenant id"
              placeholder="tenant uuid to promote"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            />
          )}
          <input
            aria-label="First admin reference"
            placeholder="first reseller-admin reference"
            value={firstAdmin}
            onChange={(e) => setFirstAdmin(e.target.value)}
            required
          />
          <input
            aria-label="Sub-tenant quota"
            type="number"
            min={0}
            placeholder="quota (default)"
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
          />
          <button type="submit">Onboard reseller</button>
        </form>
      </RequireRole>

      <label>
        Filter status{" "}
        <select
          aria-label="Filter reseller status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ResellerStatus | "")}
        >
          <option value="">all</option>
          <option value="active">active</option>
          <option value="suspended">suspended</option>
          <option value="offboarding">offboarding</option>
        </select>
      </label>

      {truncated && <p role="status">Showing the first 1000 resellers (list truncated).</p>}
      {resellers.length === 0 ? (
        <p role="status">No resellers yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Reseller</th><th>Status</th><th>Sub-tenants</th><th>Quota</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {resellers.map((r) => (
              <tr key={r.resellerId}>
                <td>{r.displayName}</td>
                <td>{r.status}</td>
                <td>{r.subTenantCount}</td>
                <td>{r.subTenantQuota}</td>
                <td>
                  <RequireRole role={sessionRole} min="admin">
                    <button type="button" aria-label={`Set quota ${r.displayName}`} onClick={() => void changeQuota(r)}>Quota</button>
                    <button type="button" aria-label={`Suspend ${r.displayName}`} onClick={() => void lifecycle(r, "suspend")}>Suspend</button>
                    <button type="button" aria-label={`Reinstate ${r.displayName}`} onClick={() => void lifecycle(r, "reinstate")}>Reinstate</button>
                    <button type="button" aria-label={`Offboard ${r.displayName}`} onClick={() => void lifecycle(r, "offboard")}>Offboard</button>
                  </RequireRole>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={move} aria-label="Move sub-tenant">
          <h4>Move a sub-tenant</h4>
          <input
            aria-label="Move sub-tenant id"
            placeholder="sub-tenant uuid"
            value={moveSubTenantId}
            onChange={(e) => setMoveSubTenantId(e.target.value)}
          />
          <input
            aria-label="Destination reseller id"
            placeholder="destination reseller uuid (blank = direct-platform)"
            value={moveDestReseller}
            onChange={(e) => setMoveDestReseller(e.target.value)}
          />
          <button type="submit">Move</button>
        </form>
      </RequireRole>
    </section>
  );
}
