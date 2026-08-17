// Plans view (US2, FR-015). Lists the plans under a selected product, lets an admin create (with a seat
// limit) and archive, and drills into a plan's entitlement values. Admin actions gated by RequireRole.
import { useState, type FormEvent } from "react";

import { ApiError, catalogApi, type Plan, type Product, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

export function Plans({
  product,
  sessionRole,
  onOpen,
  onBack,
}: {
  product: Product;
  sessionRole: Role;
  onOpen: (p: Plan) => void;
  onBack: () => void;
}): JSX.Element {
  const { data: plans = [], reload, error: loadError } = useAsync(() => catalogApi.listPlans(product.id, "all"), [product.id]);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [seats, setSeats] = useState("1");
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await catalogApi.createPlan(product.id, { key: key.trim(), name: name.trim(), maxActivations: Number(seats) });
      setKey("");
      setName("");
      setSeats("1");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That plan key already exists." : "Create failed.");
    }
  }

  async function archive(id: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.archivePlan(id);
      await reload();
    } catch {
      setError("Archive failed.");
    }
  }

  return (
    <section aria-label="Plans" className="space-y-4">
      <Button variant="ghost" size="sm" type="button" onClick={onBack}>← Products</Button>
      <PageHeader title={`Plans — ${product.name}`} />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load plans."}
        </p>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={create} aria-label="Create plan" className="flex flex-wrap items-end gap-3">
            <Input aria-label="Plan key" placeholder="standard" value={key} onChange={(e) => setKey(e.target.value)} required className="w-40" />
            <Input aria-label="Plan name" placeholder="Standard" value={name} onChange={(e) => setName(e.target.value)} required className="w-40" />
            <Input aria-label="Seat limit" type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} className="w-28" />
            <Button type="submit">Add plan</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr><Th>Key</Th><Th>Name</Th><Th>Seats</Th><Th>Status</Th><Th>Actions</Th></Tr>
        </THead>
        <TBody>
          {plans.map((p) => (
            <Tr key={p.id}>
              <Td className="font-mono text-xs">{p.key}</Td>
              <Td>{p.name}</Td>
              <Td>{p.maxActivations}</Td>
              <Td><Badge tone={statusTone(p.status)}>{p.status}</Badge></Td>
              <Td>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" type="button" onClick={() => onOpen(p)}>Entitlements</Button>
                  <RequireRole role={sessionRole} min="admin">
                    {p.status === "active" && (
                      <Button variant="danger" size="sm" type="button" onClick={() => void archive(p.id)}>Archive</Button>
                    )}
                  </RequireRole>
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
