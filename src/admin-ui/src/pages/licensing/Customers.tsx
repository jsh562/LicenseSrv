// Customers view (US5, FR-011/019). Lists the pseudonymous customer registry, lets an admin register a
// customer (duplicate ref → inline 409) and erase one (GDPR: anonymize-if-licensed else hard-delete).
// Admin-only actions are hidden from viewers by RequireRole (the server still enforces RBAC).
import { useState, type FormEvent } from "react";

import { ApiError, licensingApi, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

export function Customers({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const { data: customers = [], reload, error: loadError } = useAsync(() => licensingApi.listCustomers(), []);
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await licensingApi.createCustomer({
        ref: ref.trim(),
        name: name.trim() || undefined,
        email: email.trim() || undefined,
      });
      setRef("");
      setName("");
      setEmail("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That customer ref already exists." : "Register failed.");
    }
  }

  async function erase(id: string): Promise<void> {
    setError(null);
    try {
      await licensingApi.eraseCustomer(id);
      await reload();
    } catch {
      setError("Erase failed.");
    }
  }

  return (
    <section aria-label="Customers" className="space-y-4">
      <PageHeader title="Customers" />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load customers."}
        </p>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={create} aria-label="Register customer" className="flex flex-wrap items-end gap-3">
            <Input
              aria-label="Customer ref"
              placeholder="acct-4821"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              required
              className="w-48"
            />
            <Input
              aria-label="Customer name"
              placeholder="Jane Doe (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-48"
            />
            <Input
              aria-label="Customer email"
              type="email"
              placeholder="jane@example.com (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-56"
            />
            <Button type="submit">Register customer</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr>
            <Th>Ref</Th>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </Tr>
        </THead>
        <TBody>
          {customers.map((c) => (
            <Tr key={c.id}>
              <Td>{c.ref}</Td>
              <Td>{c.name ?? "—"}</Td>
              <Td>{c.email ?? "—"}</Td>
              <Td>
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              </Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  {c.status === "active" && (
                    <Button variant="danger" size="sm" type="button" onClick={() => void erase(c.id)}>
                      Erase
                    </Button>
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
