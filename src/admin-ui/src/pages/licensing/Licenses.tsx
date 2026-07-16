// Licenses view (US5 + US2/3/4, FR-007..013). Browses the registry with status/customer filters, retrieves
// a license's signed key on demand (viewer+), and — for admins — drives the lifecycle: suspend/reinstate,
// revoke, and transfer to a chosen target customer. Lifecycle errors (invalid transition, transfer limit)
// surface inline. Admin actions are hidden from viewers by RequireRole; the server enforces RBAC regardless.
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  licensingApi,
  type Customer,
  type License,
  type LicenseStatus,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Activations } from "./Activations";

type StatusFilter = LicenseStatus | "all";

function lifecycleError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "transfer_limit_exceeded") return "This license has reached its transfer limit.";
    if (err.code === "invalid_transition") return "That action isn't allowed for this license's current state.";
    if (err.status === 404) return "Select a valid target customer to transfer to.";
  }
  return "The action failed.";
}

export function Licenses({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [customerId, setCustomerId] = useState("");
  const [transferTarget, setTransferTarget] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [viewingSeats, setViewingSeats] = useState<License | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refDisplay = useMemo(() => new Map(customers.map((c) => [c.id, c.ref])), [customers]);

  const refresh = useCallback(async () => {
    setLicenses(
      await licensingApi.listLicenses({
        status: status === "all" ? undefined : status,
        customerId: customerId || undefined,
      }),
    );
  }, [status, customerId]);

  useEffect(() => {
    void licensingApi.listCustomers().then(setCustomers).catch(() => setError("Could not load customers."));
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load licenses."));
  }, [refresh]);

  async function showKey(id: string): Promise<void> {
    setError(null);
    try {
      const key = await licensingApi.getLicenseKey(id);
      setKeys((k) => ({ ...k, [id]: key }));
    } catch {
      setError("Could not retrieve the license key.");
    }
  }

  async function act(fn: () => Promise<License>): Promise<void> {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(lifecycleError(err));
    }
  }

  async function transfer(id: string): Promise<void> {
    if (!transferTarget) {
      setError("Choose a transfer target customer first.");
      return;
    }
    await act(() => licensingApi.transferLicense(id, transferTarget));
  }

  if (viewingSeats) {
    return <Activations license={viewingSeats} sessionRole={sessionRole} onBack={() => setViewingSeats(null)} />;
  }

  return (
    <section aria-label="Licenses">
      <h3>Licenses</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <div className="filters">
        <label>
          Status
          <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>
        <label>
          Customer
          <select aria-label="Customer filter" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.ref}</option>
            ))}
          </select>
        </label>
        <RequireRole role={sessionRole} min="admin">
          <label>
            Transfer target
            <select aria-label="Transfer target" value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
              <option value="">Select a customer…</option>
              {customers
                .filter((c) => c.status === "active")
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.ref}</option>
                ))}
            </select>
          </label>
        </RequireRole>
      </div>

      <table>
        <thead>
          <tr><th>License</th><th>Customer</th><th>Status</th><th>Expires</th><th>Transfers</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {licenses.map((l) => (
            <tr key={l.id}>
              <td>{l.id}</td>
              <td>{refDisplay.get(l.customerId) ?? l.customerId}</td>
              <td>{l.status}</td>
              <td>{l.expiresAt ?? "perpetual"}</td>
              <td>{l.transferCount}</td>
              <td>
                <button type="button" onClick={() => void showKey(l.id)}>Get key</button>
                <button type="button" onClick={() => setViewingSeats(l)}>Activations</button>
                <RequireRole role={sessionRole} min="admin">
                  {l.status === "active" && (
                    <button type="button" onClick={() => void act(() => licensingApi.suspendLicense(l.id))}>Suspend</button>
                  )}
                  {l.status === "suspended" && (
                    <button type="button" onClick={() => void act(() => licensingApi.reinstateLicense(l.id))}>Reinstate</button>
                  )}
                  {l.status !== "revoked" && (
                    <>
                      <button type="button" onClick={() => void act(() => licensingApi.revokeLicense(l.id))}>Revoke</button>
                      <button type="button" onClick={() => void transfer(l.id)}>Transfer</button>
                    </>
                  )}
                </RequireRole>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {Object.entries(keys).map(([id, key]) => (
        <div key={id} role="status" aria-label={`License key ${id}`}>
          <label>
            Key for {id}
            <textarea aria-label={`Key for ${id}`} readOnly rows={4} value={key} />
          </label>
        </div>
      ))}
    </section>
  );
}
