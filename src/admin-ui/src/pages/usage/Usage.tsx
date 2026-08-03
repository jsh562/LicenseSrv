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
    <section aria-label="Usage">
      <h3>Usage metering</h3>
      <form onSubmit={onSubmit} aria-label="Open license usage">
        <input
          aria-label="License id"
          placeholder="license uuid"
          value={licenseId}
          onChange={(e) => setLicenseId(e.target.value)}
        />
        <button type="submit">Load usage</button>
        <RequireRole role={sessionRole} min="admin">
          <label>
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

      {error && <p role="alert" className="error">{error}</p>}

      {result && (
        <>
          <p>{`Window ${result.window.from} → ${result.window.to}${result.raw ? " (true signed net)" : ""}`}</p>
          {result.truncated && <p role="status">Showing the first 1000 entitlements (list truncated).</p>}
          {result.entitlements.length === 0 ? (
            <p role="status">No usage in this window.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Entitlement</th><th>Aggregation</th><th>Unit</th><th>Value</th><th>Allowance</th><th>Over quota</th></tr>
              </thead>
              <tbody>
                {result.entitlements.map((e) => (
                  <tr key={e.entitlementId}>
                    <td>{e.entitlementId}</td>
                    <td>{e.aggregation}</td>
                    <td>{e.unit}</td>
                    <td>{e.value}</td>
                    <td>{e.allowance ?? "—"}</td>
                    <td>{e.overQuota ? "over quota" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
