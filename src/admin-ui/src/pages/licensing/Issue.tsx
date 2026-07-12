// Issue view (US1, FR-001..006). An admin picks a product → plan → customer, optionally sets an expiry
// (blank = perpetual), and issues a signed license; the returned LIC1 key is shown for copying. Fail-closed
// errors surface inline: an archived plan (409), a missing plan/customer (404), and — critically — an
// unavailable signer (503) which means NO license was minted. RequireRole gates the whole form to admin+.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  catalogApi,
  licensingApi,
  type Customer,
  type IssuedLicense,
  type Plan,
  type Product,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";

function issueError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return "The signing service is unavailable — no license was issued. Try again shortly.";
    if (err.code === "plan_not_issuable") return "That plan is archived and cannot be issued.";
    if (err.status === 404) return "The selected plan or customer no longer exists.";
  }
  return "Issue failed.";
}

export function Issue({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [products, setProducts] = useState<Product[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [productId, setProductId] = useState("");
  const [planId, setPlanId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [issued, setIssued] = useState<IssuedLicense | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [prods, custs] = await Promise.all([catalogApi.listProducts("active"), licensingApi.listCustomers()]);
    setProducts(prods);
    setCustomers(custs.filter((c) => c.status === "active"));
  }, []);

  useEffect(() => {
    void load().catch(() => setError("Could not load the catalog."));
  }, [load]);

  useEffect(() => {
    setPlanId("");
    if (!productId) {
      setPlans([]);
      return;
    }
    void catalogApi
      .listPlans(productId, "active")
      .then(setPlans)
      .catch(() => setError("Could not load plans."));
  }, [productId]);

  async function issue(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIssued(null);
    try {
      const license = await licensingApi.issueLicense({
        planId,
        customerId,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setIssued(license);
    } catch (err) {
      setError(issueError(err));
    }
  }

  return (
    <section aria-label="Issue license">
      <h3>Issue a license</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={issue} aria-label="New license">
          <label>
            Product
            <select aria-label="Product" value={productId} onChange={(e) => setProductId(e.target.value)} required>
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            Plan
            <select aria-label="Plan" value={planId} onChange={(e) => setPlanId(e.target.value)} required disabled={!productId}>
              <option value="">Select a plan…</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            Customer
            <select aria-label="Customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Select a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.ref}</option>
              ))}
            </select>
          </label>
          <label>
            Expires (blank = perpetual)
            <input aria-label="Expiry" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
          <button type="submit">Issue license</button>
        </form>
      </RequireRole>

      {issued && (
        <div role="status" aria-label="Issued license">
          <p>Issued license <code>{issued.id}</code> ({issued.expiresAt ? `expires ${issued.expiresAt}` : "perpetual"}).</p>
          <label>
            License key
            <textarea aria-label="License key" readOnly rows={4} value={issued.licenseKey} />
          </label>
        </div>
      )}
    </section>
  );
}
