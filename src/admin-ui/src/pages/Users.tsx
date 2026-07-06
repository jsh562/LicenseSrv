// Users view (US3, FR-015). Lists tenant users (metadata only — never a credential), and, for admins,
// creates/invites users, changes a role, and deactivates. Server-enforced rules surface as inline
// messages: a duplicate email (409) and the last-owner safeguard (409) both show without losing state.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { adminApi, ApiError, type Role, type UserRow } from "../api";
import { RequireRole } from "../components/RequireRole";

const ROLES: Role[] = ["viewer", "admin", "owner"];

export function Users({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setUsers(await adminApi.listUsers());
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load users."));
  }, [refresh]);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const created = await adminApi.createUser({ email: email.trim(), role });
      setNotice(`Invited ${email.trim()} (${created.status}).`);
      setEmail("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That email already exists." : "Create failed.");
    }
  }

  async function changeRole(id: string, next: Role): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await adminApi.updateUser(id, { role: next });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Can't remove the last owner." : "Update failed.");
    }
  }

  async function deactivate(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await adminApi.updateUser(id, { status: "deactivated" });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Can't deactivate the last owner." : "Update failed.");
    }
  }

  return (
    <section aria-label="Users">
      <h2>Users</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Invite user">
          <input
            aria-label="New user email"
            type="email"
            placeholder="person@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select aria-label="New user role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button type="submit">Invite</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  <select
                    aria-label={`Role for ${u.id}`}
                    value={u.role}
                    onChange={(e) => void changeRole(u.id, e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  {u.status === "active" && (
                    <button type="button" onClick={() => void deactivate(u.id)}>
                      Deactivate
                    </button>
                  )}
                </RequireRole>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
