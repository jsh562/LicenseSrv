// Entitlements view (US3, FR-015). Lists feature entitlements and lets an admin define a boolean or
// integer-limit entitlement and archive one. The key becomes the feature key embedded in issued licenses.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, catalogApi, type Entitlement, type EntitlementType, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function Entitlements({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<EntitlementType>("boolean");
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
      await catalogApi.createEntitlement({ key: key.trim(), name: name.trim(), type });
      setKey("");
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "That entitlement key already exists." : "Create failed.");
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
          <select aria-label="Entitlement type" value={type} onChange={(e) => setType(e.target.value as EntitlementType)}>
            <option value="boolean">boolean</option>
            <option value="integer_limit">integer_limit</option>
          </select>
          <button type="submit">Add entitlement</button>
        </form>
      </RequireRole>

      <table>
        <thead>
          <tr><th>Key</th><th>Name</th><th>Type</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {entitlements.map((e) => (
            <tr key={e.id}>
              <td>{e.key}</td>
              <td>{e.name}</td>
              <td>{e.type}</td>
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
