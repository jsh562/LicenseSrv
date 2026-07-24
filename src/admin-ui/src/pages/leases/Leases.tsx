// Concurrency / Leases view (US5, FR-015/016). The operator surface for floating (concurrent) seats: enter a
// license id to open its lease registry — the live + recently-ended leases (pseudonymous holderKey, scope,
// status, acquired/last-renewed/expires timestamps) plus a concurrency-used-vs-cap summary — and an admin can
// FORCE-RELEASE a live lease to reclaim its seat immediately. The signed lease handle and any raw holder
// reference are never shown (the server never returns them). Force-release is hidden from viewers by
// RequireRole; the server still enforces RBAC + double-submit CSRF fail-closed regardless of what the SPA shows.
import { useCallback, useState, type FormEvent } from "react";

import { ApiError, leaseApi, type LeaseRegistry, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function Leases({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [licenseId, setLicenseId] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [registry, setRegistry] = useState<LeaseRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const reg = await leaseApi.listLeases(id);
      setRegistry(reg);
      setLoaded(id);
    } catch (err) {
      setRegistry(null);
      setLoaded(null);
      if (err instanceof ApiError && err.status === 404) setError("No such license in this workspace.");
      else setError("Could not load leases.");
    }
  }, []);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setNotice(null);
    if (!licenseId.trim()) return;
    await load(licenseId.trim());
  }

  async function forceRelease(leaseId: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await leaseApi.forceRelease(leaseId);
      setNotice("Seat reclaimed.");
      if (loaded) await load(loaded);
    } catch {
      setError("Could not force-release the lease.");
    }
  }

  const cap = registry ? (registry.maxConcurrent ?? 0) + registry.overageAllowance : 0;

  return (
    <section aria-label="Leases">
      <h3>Concurrency / Leases</h3>
      <form onSubmit={onSubmit} aria-label="Open license leases">
        <input
          aria-label="License id"
          placeholder="license uuid"
          value={licenseId}
          onChange={(e) => setLicenseId(e.target.value)}
        />
        <button type="submit">Load leases</button>
      </form>

      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {registry && (
        <>
          <p>{`Concurrency used ${registry.concurrencyUsed} / ${cap} (cap ${registry.maxConcurrent ?? "—"}${registry.overageAllowance ? ` + overage ${registry.overageAllowance}` : ""}), scope ${registry.scope}`}</p>
          {registry.truncated && <p role="status">Showing the most recent 1000 leases (list truncated).</p>}
          <table>
            <thead>
              <tr><th>Holder</th><th>Scope</th><th>Status</th><th>Acquired</th><th>Last renewed</th><th>Expires</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {registry.leases.map((l) => (
                <tr key={l.id}>
                  <td>{l.holderKey}</td>
                  <td>{l.scope}</td>
                  <td>{l.status}</td>
                  <td>{l.acquiredAt}</td>
                  <td>{l.lastRenewedAt}</td>
                  <td>{l.expiresAt}</td>
                  <td>
                    <RequireRole role={sessionRole} min="admin">
                      {l.status === "live" && (
                        <button type="button" onClick={() => void forceRelease(l.id)}>Force-release</button>
                      )}
                    </RequireRole>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
