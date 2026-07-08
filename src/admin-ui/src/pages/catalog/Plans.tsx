// Plans view (US2, FR-015). Lists the plans under a selected product, lets an admin create (with a seat
// limit) and archive, and drills into a plan's entitlement values. Admin actions gated by RequireRole.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, catalogApi, type Plan, type Product, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

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
  const [plans, setPlans] = useState<Plan[]>([]);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [seats, setSeats] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPlans(await catalogApi.listPlans(product.id, "all"));
  }, [product.id]);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load plans."));
  }, [refresh]);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await catalogApi.createPlan(product.id, { key: key.trim(), name: name.trim(), maxActivations: Number(seats) });
      setKey("");
      setName("");
      setSeats("1");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That plan key already exists." : "Create failed.");
    }
  }

  async function archive(id: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.archivePlan(id);
      await refresh();
    } catch {
      setError("Archive failed.");
    }
  }

  return (
    <section aria-label="Plans">
      <button type="button" onClick={onBack}>← Products</button>
      <h3>Plans — {product.name}</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Create plan">
          <input aria-label="Plan key" placeholder="standard" value={key} onChange={(e) => setKey(e.target.value)} required />
          <input aria-label="Plan name" placeholder="Standard" value={name} onChange={(e) => setName(e.target.value)} required />
          <input aria-label="Seat limit" type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />
          <button type="submit">Add plan</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Key</th><th>Name</th><th>Seats</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id}>
              <td>{p.key}</td>
              <td>{p.name}</td>
              <td>{p.maxActivations}</td>
              <td>{p.status}</td>
              <td>
                <button type="button" onClick={() => onOpen(p)}>Entitlements</button>
                <RequireRole role={sessionRole} min="admin">
                  {p.status === "active" && (
                    <button type="button" onClick={() => void archive(p.id)}>Archive</button>
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
