// Users view (US3, FR-015). Lists tenant users (metadata only — never a credential), and, for admins,
// creates/invites users, changes a role, and deactivates. Server-enforced rules surface as inline
// messages: a duplicate email (409) and the last-owner safeguard (409) both show without losing state.
import { useState, type FormEvent } from "react";

import { adminApi, ApiError, type Role } from "../api";
import { RequireRole } from "../components/RequireRole";
import { Badge, statusTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input, Select } from "../components/ui/Field";
import { PageHeader } from "../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../components/ui/Table";
import { useAsync } from "../hooks/useAsync";

const ROLES: Role[] = ["viewer", "admin", "owner"];

export function Users({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const { data: users = [], reload, error: loadError } = useAsync(() => adminApi.listUsers(), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const created = await adminApi.createUser({ email: email.trim(), role });
      setNotice(`Invited ${email.trim()} (${created.status}).`);
      setEmail("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That email already exists." : "Create failed.");
    }
  }

  async function changeRole(id: string, next: Role): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await adminApi.updateUser(id, { role: next });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Can't remove the last owner." : "Update failed.");
    }
  }

  async function deactivate(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await adminApi.updateUser(id, { status: "deactivated" });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Can't deactivate the last owner." : "Update failed.");
    }
  }

  return (
    <section aria-label="Users" className="space-y-4">
      <PageHeader title="Users" description="People who can sign in to this workspace." />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load users."}
        </p>
      )}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={create} aria-label="Invite user" className="flex flex-wrap items-end gap-3">
            <Input
              aria-label="New user email"
              type="email"
              placeholder="person@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-64"
            />
            <Select
              aria-label="New user role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-36"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
            <Button type="submit">Invite</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr>
            <Th>User</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </Tr>
        </THead>
        <TBody>
          {users.map((u) => (
            <Tr key={u.id}>
              <Td className="font-mono text-xs">{u.id}</Td>
              <Td>{u.role}</Td>
              <Td>
                <Badge tone={statusTone(u.status)}>{u.status}</Badge>
              </Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  <div className="flex items-center gap-2">
                    <Select
                      aria-label={`Role for ${u.id}`}
                      value={u.role}
                      onChange={(e) => void changeRole(u.id, e.target.value as Role)}
                      className="w-28"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </Select>
                    {u.status === "active" && (
                      <Button variant="danger" size="sm" type="button" onClick={() => void deactivate(u.id)}>
                        Deactivate
                      </Button>
                    )}
                  </div>
                </RequireRole>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
