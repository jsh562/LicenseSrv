// Customers view (US5, FR-011/019). Lists the pseudonymous customer registry, lets an admin register a
// customer (duplicate ref → inline 409) and erase one (GDPR: anonymize-if-licensed else hard-delete).
// Admin-only actions are hidden from viewers by RequireRole (the server still enforces RBAC).
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, licensingApi, type Customer, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function Customers({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setCustomers(await licensingApi.listCustomers());
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load customers."));
  }, [refresh]);

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
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That customer ref already exists." : "Register failed.");
    }
  }

  async function erase(id: string): Promise<void> {
    setError(null);
    try {
      await licensingApi.eraseCustomer(id);
      await refresh();
    } catch {
      setError("Erase failed.");
    }
  }

  return (
    <section aria-label="Customers">
      <h3>Customers</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Register customer">
          <input aria-label="Customer ref" placeholder="acct-4821" value={ref} onChange={(e) => setRef(e.target.value)} required />
          <input aria-label="Customer name" placeholder="Jane Doe (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Customer email" type="email" placeholder="jane@example.com (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit">Register customer</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Ref</th><th>Name</th><th>Email</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td>{c.ref}</td>
              <td>{c.name ?? "—"}</td>
              <td>{c.email ?? "—"}</td>
              <td>{c.status}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  {c.status === "active" && (
                    <button type="button" onClick={() => void erase(c.id)}>Erase</button>
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
