// Concurrency / Leases view (US5, FR-015/016). The operator surface for floating (concurrent) seats: enter a
// license id to open its lease registry — the live + recently-ended leases (pseudonymous holderKey, scope,
// status, acquired/last-renewed/expires timestamps) plus a concurrency-used-vs-cap summary — and an admin can
// FORCE-RELEASE a live lease to reclaim its seat immediately. The signed lease handle and any raw holder
// reference are never shown (the server never returns them). Force-release is hidden from viewers by
// RequireRole; the server still enforces RBAC + double-submit CSRF fail-closed regardless of what the SPA shows.
import { useCallback, useState, type FormEvent } from "react";

import { ApiError, leaseApi, type LeaseRegistry, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";

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
    <section aria-label="Leases" className="space-y-4">
      <PageHeader title="Concurrency / Leases" description="Inspect a license's live and recently-ended floating seats." />
      <Card>
        <form onSubmit={onSubmit} aria-label="Open license leases" className="flex flex-wrap items-end gap-3">
          <Input
            aria-label="License id"
            placeholder="license uuid"
            value={licenseId}
            onChange={(e) => setLicenseId(e.target.value)}
            className="w-64"
          />
          <Button type="submit">Load leases</Button>
        </form>
      </Card>

      {error && <p role="alert" className="error text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      {registry && (
        <>
          <p className="text-sm text-fg-muted">{`Concurrency used ${registry.concurrencyUsed} / ${cap} (cap ${registry.maxConcurrent ?? "—"}${registry.overageAllowance ? ` + overage ${registry.overageAllowance}` : ""}), scope ${registry.scope}`}</p>
          {registry.truncated && <p role="status" className="text-sm text-fg-muted">Showing the most recent 1000 leases (list truncated).</p>}
          <Table>
            <THead>
              <Tr><Th>Holder</Th><Th>Scope</Th><Th>Status</Th><Th>Acquired</Th><Th>Last renewed</Th><Th>Expires</Th><Th>Actions</Th></Tr>
            </THead>
            <TBody>
              {registry.leases.map((l) => (
                <Tr key={l.id}>
                  <Td className="font-mono text-xs">{l.holderKey}</Td>
                  <Td>{l.scope}</Td>
                  <Td><Badge tone={statusTone(l.status)}>{l.status}</Badge></Td>
                  <Td className="text-xs text-fg-muted">{l.acquiredAt}</Td>
                  <Td className="text-xs text-fg-muted">{l.lastRenewedAt}</Td>
                  <Td className="text-xs text-fg-muted">{l.expiresAt}</Td>
                  <Td>
                    <RequireRole role={sessionRole} min="admin">
                      {l.status === "live" && (
                        <Button variant="danger" size="sm" type="button" onClick={() => void forceRelease(l.id)}>Force-release</Button>
                      )}
                    </RequireRole>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </>
      )}
    </section>
  );
}
