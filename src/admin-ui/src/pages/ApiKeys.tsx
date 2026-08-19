// API keys view (US4, FR-015). Lists key metadata (never a secret), and lets an admin create, rotate,
// and revoke. The plaintext secret returned by create/rotate is surfaced EXACTLY ONCE, in a dismissible
// banner — it is never stored in state beyond that or refetched, mirroring the server's show-once rule.
import { useState } from "react";

import { adminApi, type Role, type Scope } from "../api";
import { RequireRole } from "../components/RequireRole";
import { Badge, statusTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { PageHeader } from "../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../components/ui/Table";
import { useAsync } from "../hooks/useAsync";

const SCOPES: Scope[] = ["activate", "validate", "admin"];

export function ApiKeys({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const { data: keys = [], reload, error: loadError } = useAsync(() => adminApi.listApiKeys(), []);
  const [selected, setSelected] = useState<Scope[]>(["validate"]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(scope: Scope): void {
    setSelected((cur) => (cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]));
  }

  async function create(): Promise<void> {
    setError(null);
    try {
      const created = await adminApi.createApiKey(selected);
      setRevealedSecret(created.secret);
      await reload();
    } catch {
      setError("Create failed.");
    }
  }

  async function rotate(id: string): Promise<void> {
    setError(null);
    try {
      const rotated = await adminApi.rotateApiKey(id);
      setRevealedSecret(rotated.secret);
      await reload();
    } catch {
      setError("Rotate failed.");
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    try {
      await adminApi.revokeApiKey(id);
      await reload();
    } catch {
      setError("Revoke failed.");
    }
  }

  return (
    <section aria-label="API keys" className="space-y-4">
      <PageHeader title="API Keys" description="Machine credentials your software uses to call the API — scoped, not people. (Users, by contrast, are humans who sign in.)" />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load API keys."}
        </p>
      )}

      {revealedSecret && (
        <div
          role="alert"
          className="secret-once flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <p>Copy this secret now — it will not be shown again:</p>
          <code className="rounded bg-surface px-2 py-1 font-mono text-xs">{revealedSecret}</code>
          <Button variant="secondary" size="sm" type="button" onClick={() => setRevealedSecret(null)}>
            Done
          </Button>
        </div>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <fieldset aria-label="New key scopes" className="flex flex-wrap items-center gap-4">
            <legend className="mb-2 text-sm font-medium">New key scopes</legend>
            {SCOPES.map((s) => (
              <label key={s} className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={selected.includes(s)} onChange={() => toggle(s)} /> {s}
              </label>
            ))}
            <Button type="button" onClick={() => void create()} disabled={selected.length === 0}>
              Create key
            </Button>
          </fieldset>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr>
            <Th>Key ID</Th>
            <Th>Scopes</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </Tr>
        </THead>
        <TBody>
          {keys.map((k) => (
            <Tr key={k.id}>
              <Td className="font-mono text-xs">{k.id}</Td>
              <Td>{k.scopes.join(", ")}</Td>
              <Td>
                <Badge tone={statusTone(k.status)}>{k.status}</Badge>
              </Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  {k.status === "active" && (
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" type="button" onClick={() => void rotate(k.id)}>
                        Rotate
                      </Button>
                      <Button variant="danger" size="sm" type="button" onClick={() => void revoke(k.id)}>
                        Revoke
                      </Button>
                    </div>
                  )}
                </RequireRole>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
