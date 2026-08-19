// Usage metering view (US2, FR-011/013/014; SC-004/017/019). The operator surface for consumption metering:
// enter a license id + a query window to load its per-metered-entitlement aggregate — the aggregation type,
// unit, accrued value, optional allowance, and the over-quota signal. By default values are FLOORED at zero
// for display (a viewer never sees negative usage after a reversal); an ADMIN may toggle "true signed net"
// (`raw=true`) to see the reproducible stored value billing true-up (E014) consumes — the toggle is hidden
// from viewers by RequireRole, and the server still enforces the admin bound fail-closed regardless. The
// reproducible aggregate is read-only; no secret/key is ever shown.
import { useCallback, useState, type FormEvent } from "react";

import { ApiError, usageApi, type Role, type UsageQueryResult } from "../../api";
import { RequireRole, roleAtLeast } from "../../components/RequireRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";

/** A default window: the last 7 days up to now (RFC3339 UTC), comfortably under the server's span bound. */
function defaultWindow(): { from: string; to: string } {
  const now = Date.now();
  return { from: new Date(now - 7 * 24 * 3_600_000).toISOString(), to: new Date(now).toISOString() };
}

export function Usage({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [licenseId, setLicenseId] = useState("");
  const [raw, setRaw] = useState(false);
  const [result, setResult] = useState<UsageQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string, wantRaw: boolean) => {
      setError(null);
      try {
        const win = defaultWindow();
        const res = await usageApi.getUsage(id, { ...win, raw: wantRaw && roleAtLeast(sessionRole, "admin") });
        setResult(res);
      } catch (err) {
        setResult(null);
        if (err instanceof ApiError && err.status === 404) setError("No such license in this workspace.");
        else if (err instanceof ApiError && err.status === 403) setError("The true signed net requires the admin role.");
        else setError("Could not load usage.");
      }
    },
    [sessionRole],
  );

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!licenseId.trim()) return;
    await load(licenseId.trim(), raw);
  }

  async function toggleRaw(next: boolean): Promise<void> {
    setRaw(next);
    if (result) await load(result.licenseId, next);
  }

  return (
    <section aria-label="Usage" className="space-y-4">
      <PageHeader title="Usage metering" description="Load a license's per-entitlement consumption aggregate for a window." />
      <Card>
        <form onSubmit={onSubmit} aria-label="Open license usage" className="flex flex-wrap items-end gap-3">
          <Input
            aria-label="License id"
            placeholder="license uuid"
            value={licenseId}
            onChange={(e) => setLicenseId(e.target.value)}
            className="w-64"
          />
          <Button type="submit">Load usage</Button>
          <RequireRole role={sessionRole} min="admin">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="Show true signed net"
                checked={raw}
                onChange={(e) => void toggleRaw(e.target.checked)}
              />
              True signed net
            </label>
          </RequireRole>
        </form>
      </Card>

      {error && <p role="alert" className="error text-sm text-danger">{error}</p>}

      {result && (
        <>
          <p className="text-sm text-fg-muted">{`Window ${result.window.from} → ${result.window.to}${result.raw ? " (true signed net)" : ""}`}</p>
          {result.truncated && <p role="status" className="text-sm text-fg-muted">Showing the first 1000 entitlements (list truncated).</p>}
          {result.entitlements.length === 0 ? (
            <p role="status" className="text-sm text-fg-muted">No usage in this window.</p>
          ) : (
            <Table>
              <THead>
                <Tr><Th>Entitlement</Th><Th>Aggregation</Th><Th>Unit</Th><Th>Value</Th><Th>Allowance</Th><Th>Over quota</Th></Tr>
              </THead>
              <TBody>
                {result.entitlements.map((e) => (
                  <Tr key={e.entitlementId}>
                    <Td className="font-mono text-xs">{e.entitlementId}</Td>
                    <Td>{e.aggregation}</Td>
                    <Td>{e.unit}</Td>
                    <Td>{e.value}</Td>
                    <Td>{e.allowance ?? "—"}</Td>
                    <Td>{e.overQuota ? "over quota" : "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}
    </section>
  );
}
