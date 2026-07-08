// Products view (US1, FR-015). Lists products (all statuses), lets an admin create and archive, and
// drills into a product's plans. Admin-only actions are hidden from viewers by RequireRole.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, catalogApi, type Product, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function Products({ sessionRole, onOpen }: { sessionRole: Role; onOpen: (p: Product) => void }): JSX.Element {
  const [products, setProducts] = useState<Product[]>([]);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProducts(await catalogApi.listProducts("all"));
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load products."));
  }, [refresh]);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await catalogApi.createProduct({ key: key.trim(), name: name.trim() });
      setKey("");
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That product key already exists." : "Create failed.");
    }
  }

  async function archive(id: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.archiveProduct(id);
      await refresh();
    } catch {
      setError("Archive failed.");
    }
  }

  return (
    <section aria-label="Products">
      <h3>Products</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Create product">
          <input aria-label="Product key" placeholder="acme-cad" value={key} onChange={(e) => setKey(e.target.value)} required />
          <input aria-label="Product name" placeholder="Acme CAD" value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit">Add product</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Key</th><th>Name</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>{p.key}</td>
              <td>{p.name}</td>
              <td>{p.status}</td>
              <td>
                <button type="button" onClick={() => onOpen(p)}>Plans</button>
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
