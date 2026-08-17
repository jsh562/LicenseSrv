// Billing view (US5, FR-015/017/022). The MINIMAL operator surface for billing-driven entitlement
// automation: connect a provider, list connections (via the secret-excluding read model), set a single
// plan-map entry + the grace policy, ROTATE the signing secret, and trigger on-demand reconciliation. The
// webhook signing secret is WRITE-ONLY — it is entered in a password field, sent on create/rotate, and NEVER
// displayed (the API never returns it). Admin-only actions are hidden from viewers by RequireRole; the server
// still enforces RBAC + CSRF fail-closed regardless of what the SPA shows.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, billingApi, type BillingConnection, type BillingProvider, type PlanMap, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";

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
    <section aria-label="Billing" className="space-y-4">
      <PageHeader
        title="Billing connections"
        description="Connect a provider, map a plan, and rotate the write-only signing secret."
        actions={
          <RequireRole role={sessionRole} min="admin">
            <Button variant="secondary" type="button" onClick={() => void reconcile()}>Reconcile now</Button>
          </RequireRole>
        }
      />
      {error && <p role="alert" className="error text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={create} aria-label="Connect provider" className="flex flex-wrap items-end gap-3">
            <Select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as BillingProvider)} className="w-36">
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
            {/* Write-only: a password field, never rendered back, cleared on submit. */}
            <Input
              aria-label="Signing secret"
              type="password"
              placeholder="whsec_… (write-only)"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              required
              className="w-56"
            />
            <Input
              aria-label="Default grace seconds"
              type="number"
              min={1}
              placeholder="1209600"
              value={defaultGraceSeconds}
              onChange={(e) => setDefaultGraceSeconds(e.target.value)}
              className="w-40"
            />
            <Input aria-label="Plan key" placeholder="price_pro_monthly (optional)" value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="w-56" />
            <Input aria-label="Product id" placeholder="product uuid (optional)" value={productId} onChange={(e) => setProductId(e.target.value)} className="w-56" />
            <Input aria-label="Plan id" placeholder="plan uuid (optional)" value={planId} onChange={(e) => setPlanId(e.target.value)} className="w-56" />
            <Button type="submit">Connect provider</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr><Th>Provider</Th><Th>Status</Th><Th>Grace (s)</Th><Th>Plan map</Th><Th>Secret rotated</Th><Th>Actions</Th></Tr>
        </THead>
        <TBody>
          {connections.map((c) => (
            <Tr key={c.id}>
              <Td>{c.provider}</Td>
              <Td><Badge tone={statusTone(c.status)}>{c.status}</Badge></Td>
              <Td>{c.defaultGraceSeconds}</Td>
              <Td>{Object.keys(c.planMap).join(", ") || "—"}</Td>
              <Td className="text-xs text-fg-muted">{c.secretRotatedAt ?? "never"}</Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" type="button" onClick={() => void rotate(c.id)}>Rotate secret</Button>
                    <Button variant="secondary" size="sm" type="button" onClick={() => void toggleStatus(c)}>
                      {c.status === "active" ? "Disable" : "Enable"}
                    </Button>
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
