// Billing view (US5, FR-015/017/022). The MINIMAL operator surface for billing-driven entitlement
// automation: connect a provider, list connections (via the secret-excluding read model), set a single
// plan-map entry + the grace policy, ROTATE the signing secret, and trigger on-demand reconciliation. The
// webhook signing secret is WRITE-ONLY — it is entered in a password field, sent on create/rotate, and NEVER
// displayed (the API never returns it). Admin-only actions are hidden from viewers by RequireRole; the server
// still enforces RBAC + CSRF fail-closed regardless of what the SPA shows.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, billingApi, type BillingConnection, type BillingProvider, type PlanMap, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

const PROVIDERS: BillingProvider[] = ["stripe", "paddle", "generic"];

export function Billing({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [connections, setConnections] = useState<BillingConnection[]>([]);
  const [provider, setProvider] = useState<BillingProvider>("stripe");
  const [signingSecret, setSigningSecret] = useState("");
  const [defaultGraceSeconds, setDefaultGraceSeconds] = useState("1209600");
  const [planKey, setPlanKey] = useState("");
  const [productId, setProductId] = useState("");
  const [planId, setPlanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setConnections(await billingApi.listConnections());
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load connections."));
  }, [refresh]);

  function buildPlanMap(): PlanMap | undefined {
    if (!planKey.trim() || !productId.trim() || !planId.trim()) return undefined;
    return { [planKey.trim()]: { productId: productId.trim(), planId: planId.trim() } };
  }

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await billingApi.createConnection({
        provider,
        signingSecret,
        planMap: buildPlanMap(),
        defaultGraceSeconds: Number(defaultGraceSeconds) || undefined,
      });
      // Clear the write-only secret from memory the moment it is submitted; it is never displayed again.
      setSigningSecret("");
      setPlanKey("");
      setProductId("");
      setPlanId("");
      setNotice("Connection created.");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate_connection") setError("A connection already exists for that provider.");
      else if (err instanceof ApiError && err.code === "invalid_plan_map") setError("The plan mapping references an unknown or archived catalog plan.");
      else setError("Create failed.");
    }
  }

  async function rotate(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    const next = window.prompt("New signing secret (write-only — it will not be displayed after saving):");
    if (!next) return;
    try {
      await billingApi.rotateSecret(id, next);
      setNotice("Secret rotated. The previous secret stays valid only during the transition window.");
      await refresh();
    } catch {
      setError("Rotate failed.");
    }
  }

  async function toggleStatus(c: BillingConnection): Promise<void> {
    setError(null);
    try {
      await billingApi.updateConnection(c.id, { status: c.status === "active" ? "disabled" : "active" });
      await refresh();
    } catch {
      setError("Update failed.");
    }
  }

  async function reconcile(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const r = await billingApi.reconcile();
      setNotice(`Reconciliation accepted (job ${r.jobId}); corrections appear in the subscription and event registries.`);
    } catch {
      setError("Reconcile failed.");
    }
  }

  return (
    <section aria-label="Billing">
      <h3>Billing connections</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Connect provider">
          <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as BillingProvider)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {/* Write-only: a password field, never rendered back, cleared on submit. */}
          <input
            aria-label="Signing secret"
            type="password"
            placeholder="whsec_… (write-only)"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            required
          />
          <input
            aria-label="Default grace seconds"
            type="number"
            min={1}
            placeholder="1209600"
            value={defaultGraceSeconds}
            onChange={(e) => setDefaultGraceSeconds(e.target.value)}
          />
          <input aria-label="Plan key" placeholder="price_pro_monthly (optional)" value={planKey} onChange={(e) => setPlanKey(e.target.value)} />
          <input aria-label="Product id" placeholder="product uuid (optional)" value={productId} onChange={(e) => setProductId(e.target.value)} />
          <input aria-label="Plan id" placeholder="plan uuid (optional)" value={planId} onChange={(e) => setPlanId(e.target.value)} />
          <button type="submit">Connect provider</button>
        </form>

        <button type="button" onClick={() => void reconcile()}>Reconcile now</button>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Provider</th><th>Status</th><th>Grace (s)</th><th>Plan map</th><th>Secret rotated</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {connections.map((c) => (
            <tr key={c.id}>
              <td>{c.provider}</td>
              <td>{c.status}</td>
              <td>{c.defaultGraceSeconds}</td>
              <td>{Object.keys(c.planMap).join(", ") || "—"}</td>
              <td>{c.secretRotatedAt ?? "never"}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  <button type="button" onClick={() => void rotate(c.id)}>Rotate secret</button>
                  <button type="button" onClick={() => void toggleStatus(c)}>
                    {c.status === "active" ? "Disable" : "Enable"}
                  </button>
                </RequireRole>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
