// Entitlements view (US3, FR-015; E016 FR-008). Lists feature entitlements and lets an admin define a boolean,
// integer-limit, or METERED entitlement (aggregation type + unit + optional allowance) and archive one. The key
// becomes the feature key embedded in issued licenses. For a metered kind the aggregation/unit/allowance fields
// appear; the server (assertMeteredShape) is the authoritative validator (counter-only, unit required).
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  catalogApi,
  type Entitlement,
  type EntitlementKind,
  type MeteredAggregation,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function Entitlements({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<EntitlementKind>("boolean");
  const [aggregation, setAggregation] = useState<MeteredAggregation>("sum");
  const [unit, setUnit] = useState("");
  const [allowance, setAllowance] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setEntitlements(await catalogApi.listEntitlements("all"));
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load entitlements."));
  }, [refresh]);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      if (type === "metered") {
        await catalogApi.createEntitlement({
          key: key.trim(),
          name: name.trim(),
          type,
          aggregation,
          unit: unit.trim(),
          ...(allowance.trim() !== "" ? { allowance: Number(allowance) } : {}),
        });
      } else {
        await catalogApi.createEntitlement({ key: key.trim(), name: name.trim(), type });
      }
      setKey("");
      setName("");
      setUnit("");
      setAllowance("");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError("That entitlement key already exists.");
      else if (err instanceof ApiError && err.status === 400) setError("The metered definition is invalid (aggregation and unit are required).");
      else setError("Create failed.");
    }
  }

  async function archive(id: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.archiveEntitlement(id);
      await refresh();
    } catch {
      setError("Archive failed.");
    }
  }

  return (
    <section aria-label="Entitlements">
      <h3>Entitlements</h3>
      {error && <p role="alert" className="error">{error}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={create} aria-label="Create entitlement">
          <input aria-label="Entitlement key" placeholder="export-pdf" value={key} onChange={(e) => setKey(e.target.value)} required />
          <input aria-label="Entitlement name" placeholder="Export PDF" value={name} onChange={(e) => setName(e.target.value)} required />
          <select aria-label="Entitlement type" value={type} onChange={(e) => setType(e.target.value as EntitlementKind)}>
            <option value="boolean">boolean</option>
            <option value="integer_limit">integer_limit</option>
            <option value="metered">metered</option>
          </select>
          {type === "metered" && (
            <>
              <select aria-label="Aggregation" value={aggregation} onChange={(e) => setAggregation(e.target.value as MeteredAggregation)}>
                <option value="sum">sum</option>
                <option value="count">count</option>
                <option value="unique_count">unique_count</option>
              </select>
              <input aria-label="Unit" placeholder="gb" value={unit} onChange={(e) => setUnit(e.target.value)} required />
              <input aria-label="Allowance" type="number" min="0" placeholder="allowance (optional)" value={allowance} onChange={(e) => setAllowance(e.target.value)} />
            </>
          )}
          <button type="submit">Add entitlement</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Key</th><th>Name</th><th>Type</th><th>Aggregation</th><th>Unit</th><th>Allowance</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {entitlements.map((e) => (
            <tr key={e.id}>
              <td>{e.key}</td>
              <td>{e.name}</td>
              <td>{e.type}</td>
              <td>{e.aggregation ?? "-"}</td>
              <td>{e.unit ?? "-"}</td>
              <td>{e.allowance ?? "-"}</td>
              <td>{e.status}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  {e.status === "active" && (
                    <button type="button" onClick={() => void archive(e.id)}>Archive</button>
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
