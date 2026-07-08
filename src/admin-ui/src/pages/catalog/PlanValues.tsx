// Plan values view (US4, FR-015). The no-code core: attach entitlements to a plan and set each value
// (boolean on/off, or a non-negative integer limit), edit in place, and remove. A value that does not
// match the entitlement's type surfaces a field-level error (the server's 400). Admin-gated.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  catalogApi,
  type Entitlement,
  type Plan,
  type PlanEntitlementValue,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function PlanValues({ plan, sessionRole, onBack }: { plan: Plan; sessionRole: Role; onBack: () => void }): JSX.Element {
  const [values, setValues] = useState<PlanEntitlementValue[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [selected, setSelected] = useState("");
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [vals, ents] = await Promise.all([catalogApi.listPlanEntitlements(plan.id), catalogApi.listEntitlements("active")]);
    setValues(vals);
    setEntitlements(ents);
  }, [plan.id]);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load plan entitlements."));
  }, [refresh]);

  const chosen = entitlements.find((e) => e.id === selected);

  async function set(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!chosen) return;
    // For a boolean the select defaults to "on"; treat only an explicit "false" as off (matches display).
    const value: boolean | number = chosen.type === "boolean" ? raw !== "false" : Number(raw);
    try {
      await catalogApi.setPlanValue(plan.id, chosen.id, value);
      setRaw("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? "That value doesn't match the entitlement's type." : "Save failed.");
    }
  }

  async function remove(entitlementId: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.removePlanValue(plan.id, entitlementId);
      await refresh();
    } catch {
      setError("Remove failed.");
    }
  }

  return (
    <section aria-label="Plan entitlements">
      <button type="button" onClick={onBack}>← Plans</button>
      <h3>Entitlement values — {plan.name}</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={set} aria-label="Set entitlement value">
          <select aria-label="Entitlement" value={selected} onChange={(e) => setSelected(e.target.value)} required>
            <option value="">Choose an entitlement…</option>
            {entitlements.map((e) => (
              <option key={e.id} value={e.id}>{e.key} ({e.type})</option>
            ))}
          </select>
          {chosen?.type === "boolean" ? (
            <select aria-label="Boolean value" value={raw} onChange={(e) => setRaw(e.target.value)}>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          ) : (
            <input aria-label="Limit value" type="text" placeholder="50" value={raw} onChange={(e) => setRaw(e.target.value)} />
          )}
          <button type="submit" disabled={!chosen}>Set value</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Entitlement</th><th>Type</th><th>Value</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {values.map((v) => (
            <tr key={v.entitlementId}>
              <td>{v.key}</td>
              <td>{v.type}</td>
              <td>{String(v.value)}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  <button type="button" onClick={() => void remove(v.entitlementId)}>Remove</button>
                </RequireRole>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
