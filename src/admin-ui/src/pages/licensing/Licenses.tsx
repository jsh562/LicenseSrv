// Licenses view (US5 + US2/3/4, FR-007..013). Browses the registry with status/customer filters, retrieves
// a license's signed key on demand (viewer+), and — for admins — drives the lifecycle: suspend/reinstate,
// revoke, and transfer to a chosen target customer. Lifecycle errors (invalid transition, transfer limit)
// surface inline. Admin actions are hidden from viewers by RequireRole; the server enforces RBAC regardless.
import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  licensingApi,
  type Customer,
  type License,
  type LicenseStatus,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Select, Textarea } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";
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
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [customerId, setCustomerId] = useState("");
  const [transferTarget, setTransferTarget] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [viewingSeats, setViewingSeats] = useState<License | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    data: licenses = [],
    reload: refresh,
    error: loadError,
  } = useAsync(
    () =>
      licensingApi.listLicenses({
        status: status === "all" ? undefined : status,
        customerId: customerId || undefined,
      }),
    [status, customerId],
  );

  const refDisplay = useMemo(() => new Map(customers.map((c) => [c.id, c.ref])), [customers]);

  useEffect(() => {
    void licensingApi.listCustomers().then(setCustomers).catch(() => setError("Could not load customers."));
  }, []);

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
    <section aria-label="Licenses" className="space-y-4">
      <PageHeader title="Licenses" description="Every issued license and its lifecycle — suspend, reinstate, revoke, transfer, and drill into activations." />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load licenses."}
        </p>
      )}

      <Card>
        <div className="filters flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="revoked">Revoked</option>
            </Select>
          </Field>
          <Field label="Customer">
            <Select aria-label="Customer filter" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.ref}</option>
              ))}
            </Select>
          </Field>
          <RequireRole role={sessionRole} min="admin">
            <Field label="Transfer target">
              <Select aria-label="Transfer target" value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
                <option value="">Select a customer…</option>
                {customers
                  .filter((c) => c.status === "active")
                  .map((c) => (
                    <option key={c.id} value={c.id}>{c.ref}</option>
                  ))}
              </Select>
            </Field>
          </RequireRole>
        </div>
      </Card>

      <Table>
        <THead>
          <Tr>
            <Th>License</Th>
            <Th>Customer</Th>
            <Th>Status</Th>
            <Th>Expires</Th>
            <Th>Transfers</Th>
            <Th>Actions</Th>
          </Tr>
        </THead>
        <TBody>
          {licenses.map((l) => (
            <Tr key={l.id}>
              <Td>{l.id}</Td>
              <Td>{refDisplay.get(l.customerId) ?? l.customerId}</Td>
              <Td>
                <Badge tone={statusTone(l.status)}>{l.status}</Badge>
              </Td>
              <Td>{l.expiresAt ?? "perpetual"}</Td>
              <Td>{l.transferCount}</Td>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" type="button" onClick={() => void showKey(l.id)}>Get key</Button>
                  <Button variant="ghost" size="sm" type="button" onClick={() => setViewingSeats(l)}>Activations</Button>
                  <RequireRole role={sessionRole} min="admin">
                    {l.status === "active" && (
                      <Button variant="secondary" size="sm" type="button" onClick={() => void act(() => licensingApi.suspendLicense(l.id))}>Suspend</Button>
                    )}
                    {l.status === "suspended" && (
                      <Button variant="secondary" size="sm" type="button" onClick={() => void act(() => licensingApi.reinstateLicense(l.id))}>Reinstate</Button>
                    )}
                    {l.status !== "revoked" && (
                      <>
                        <Button variant="danger" size="sm" type="button" onClick={() => void act(() => licensingApi.revokeLicense(l.id))}>Revoke</Button>
                        <Button variant="secondary" size="sm" type="button" onClick={() => void transfer(l.id)}>Transfer</Button>
                      </>
                    )}
                  </RequireRole>
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      {Object.entries(keys).map(([id, key]) => (
        <Card key={id}>
          <div role="status" aria-label={`License key ${id}`}>
            <Field label={`Key for ${id}`}>
              <Textarea aria-label={`Key for ${id}`} readOnly rows={4} value={key} />
            </Field>
          </div>
        </Card>
      ))}
    </section>
  );
}
