// Activations view (US4, FR-012). Shows one license's activation registry — its bound machines (pseudonymous
// machine identity, status, timestamps) and a seats-used-vs-limit summary — and lets an admin reclaim a seat
// by deactivating an active machine. The machine-bound credential and raw signals are never shown (the server
// never returns them). Reclaim is hidden from viewers by RequireRole; the server enforces RBAC regardless.
import { useState } from "react";

import { activationApi, type License, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

export function Activations({ license, sessionRole, onBack }: { license: License; sessionRole: Role; onBack: () => void }): JSX.Element {
  const { data, reload, error: loadError } = useAsync(() => activationApi.listActivations(license.id), [license.id]);
  const [error, setError] = useState<string | null>(null);

  const activations = data?.activations ?? [];
  const seatsUsed = data?.seatsUsed ?? 0;
  const seatLimit = data?.seatLimit ?? license.maxActivations;

  async function reclaim(activationId: string): Promise<void> {
    setError(null);
    try {
      await activationApi.reclaim(license.id, activationId);
      await reload();
    } catch {
      setError("Could not reclaim the seat.");
    }
  }

  return (
    <section aria-label="Activations" className="space-y-4">
      <Button variant="ghost" size="sm" type="button" onClick={onBack}>← Licenses</Button>
      <PageHeader title={`Activations for ${license.id}`} description={`Seats used ${seatsUsed} / ${seatLimit}`} />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load activations."}
        </p>
      )}

      <Table>
        <THead>
          <Tr>
            <Th>Machine</Th>
            <Th>Status</Th>
            <Th>Activated</Th>
            <Th>Deactivated</Th>
            <Th>Label</Th>
            <Th>Actions</Th>
          </Tr>
        </THead>
        <TBody>
          {activations.map((a) => (
            <Tr key={a.id}>
              <Td>{a.machineId}</Td>
              <Td>
                <Badge tone={statusTone(a.status)}>{a.status}</Badge>
              </Td>
              <Td>{a.activatedAt}</Td>
              <Td>{a.deactivatedAt ?? "—"}</Td>
              <Td>{a.label ?? "—"}</Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  {a.status === "active" && (
                    <Button variant="danger" size="sm" type="button" onClick={() => void reclaim(a.id)}>Reclaim seat</Button>
                  )}
                </RequireRole>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
