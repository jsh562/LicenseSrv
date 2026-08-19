// Products view (US1, FR-015). Lists products (all statuses), lets an admin create and archive, and
// drills into a product's plans. Admin-only actions are hidden from viewers by RequireRole.
import { useState, type FormEvent } from "react";

import { ApiError, catalogApi, type Product, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

export function Products({ sessionRole, onOpen }: { sessionRole: Role; onOpen: (p: Product) => void }): JSX.Element {
  const { data: products = [], reload, error: loadError } = useAsync(() => catalogApi.listProducts("all"), []);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await catalogApi.createProduct({ key: key.trim(), name: name.trim() });
      setKey("");
      setName("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That product key already exists." : "Create failed.");
    }
  }

  async function archive(id: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.archiveProduct(id);
      await reload();
    } catch {
      setError("Archive failed.");
    }
  }

  return (
    <section aria-label="Products" className="space-y-4">
      <PageHeader title="Products" description="The applications you license. Each product holds its own plans and its own signing key." />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load products."}
        </p>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={create} aria-label="Create product" className="flex flex-wrap items-end gap-3">
            <Input aria-label="Product key" placeholder="acme-cad" value={key} onChange={(e) => setKey(e.target.value)} required className="w-48" />
            <Input aria-label="Product name" placeholder="Acme CAD" value={name} onChange={(e) => setName(e.target.value)} required className="w-48" />
            <Button type="submit">Add product</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr><Th>Key</Th><Th>Name</Th><Th>Status</Th><Th>Actions</Th></Tr>
        </THead>
        <TBody>
          {products.map((p) => (
            <Tr key={p.id}>
              <Td className="font-mono text-xs">{p.key}</Td>
              <Td>{p.name}</Td>
              <Td><Badge tone={statusTone(p.status)}>{p.status}</Badge></Td>
              <Td>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" type="button" onClick={() => onOpen(p)}>Plans</Button>
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
