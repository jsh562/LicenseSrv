// API keys view (US4, FR-015). Lists key metadata (never a secret), and lets an admin create, rotate,
// and revoke. The plaintext secret returned by create/rotate is surfaced EXACTLY ONCE, in a dismissible
// banner — it is never stored in state beyond that or refetched, mirroring the server's show-once rule.
import { useCallback, useEffect, useState } from "react";

import { adminApi, type ApiKeyMeta, type Scope } from "../api";
import { RequireRole } from "../components/RequireRole";

const SCOPES: Scope[] = ["activate", "validate", "admin"];

export function ApiKeys({ sessionRole }: { sessionRole: import("../api").Role }): JSX.Element {
  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [selected, setSelected] = useState<Scope[]>(["validate"]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setKeys(await adminApi.listApiKeys());
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load API keys."));
  }, [refresh]);

  function toggle(scope: Scope): void {
    setSelected((cur) => (cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]));
  }

  async function create(): Promise<void> {
    setError(null);
    try {
      const created = await adminApi.createApiKey(selected);
      setRevealedSecret(created.secret);
      await refresh();
    } catch {
      setError("Create failed.");
    }
  }

  async function rotate(id: string): Promise<void> {
    setError(null);
    try {
      const rotated = await adminApi.rotateApiKey(id);
      setRevealedSecret(rotated.secret);
      await refresh();
    } catch {
      setError("Rotate failed.");
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    try {
      await adminApi.revokeApiKey(id);
      await refresh();
    } catch {
      setError("Revoke failed.");
    }
  }

  return (
    <section aria-label="API keys">
      <h2>API Keys</h2>
      {error && <p role="alert" className="error">{error}</p>}

      {revealedSecret && (
        <div role="alert" className="secret-once">
          <p>Copy this secret now — it will not be shown again:</p>
          <code>{revealedSecret}</code>
          <button type="button" onClick={() => setRevealedSecret(null)}>
            Done
          </button>
        </div>
      )}

      <RequireRole role={sessionRole} min="admin">
        <fieldset aria-label="New key scopes">
          <legend>New key scopes</legend>
          {SCOPES.map((s) => (
            <label key={s}>
              <input type="checkbox" checked={selected.includes(s)} onChange={() => toggle(s)} /> {s}
            </label>
          ))}
          <button type="button" onClick={() => void create()} disabled={selected.length === 0}>
            Create key
          </button>
        </fieldset>
      </RequireRole>

      <table>
        <thead>
          <tr>
            <th>Key ID</th>
            <th>Scopes</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.id}</td>
              <td>{k.scopes.join(", ")}</td>
              <td>{k.status}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  {k.status === "active" && (
                    <>
                      <button type="button" onClick={() => void rotate(k.id)}>Rotate</button>
                      <button type="button" onClick={() => void revoke(k.id)}>Revoke</button>
                    </>
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
