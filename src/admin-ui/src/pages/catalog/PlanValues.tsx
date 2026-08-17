// Plan values view (US4, FR-015). The no-code core: attach entitlements to a plan and set each value
// (boolean on/off, or a non-negative integer limit), edit in place, and remove. A value that does not
// match the entitlement's type surfaces a field-level error (the server's 400). Admin-gated.
import { useState, type FormEvent } from "react";

import { ApiError, catalogApi, type Plan, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

export function PlanValues({ plan, sessionRole, onBack }: { plan: Plan; sessionRole: Role; onBack: () => void }): JSX.Element {
  const { data, reload, error: loadError } = useAsync(async () => {
    const [vals, ents] = await Promise.all([catalogApi.listPlanEntitlements(plan.id), catalogApi.listEntitlements("active")]);
    return { vals, ents };
  }, [plan.id]);
  const values = data?.vals ?? [];
  const entitlements = data?.ents ?? [];
  const [selected, setSelected] = useState("");
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

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
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? "That value doesn't match the entitlement's type." : "Save failed.");
    }
  }

  async function remove(entitlementId: string): Promise<void> {
    setError(null);
    try {
      await catalogApi.removePlanValue(plan.id, entitlementId);
      await reload();
    } catch {
      setError("Remove failed.");
    }
  }

  return (
    <section aria-label="Plan entitlements" className="space-y-4">
      <Button variant="ghost" size="sm" type="button" onClick={onBack}>← Plans</Button>
      <PageHeader title={`Entitlement values — ${plan.name}`} />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load plan entitlements."}
        </p>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={set} aria-label="Set entitlement value" className="flex flex-wrap items-end gap-3">
            <Select aria-label="Entitlement" value={selected} onChange={(e) => setSelected(e.target.value)} required className="w-64">
              <option value="">Choose an entitlement…</option>
              {entitlements.map((e) => (
                <option key={e.id} value={e.id}>{e.key} ({e.type})</option>
              ))}
            </Select>
            {chosen?.type === "boolean" ? (
              <Select aria-label="Boolean value" value={raw} onChange={(e) => setRaw(e.target.value)} className="w-28">
                <option value="true">on</option>
                <option value="false">off</option>
              </Select>
            ) : (
              <Input aria-label="Limit value" type="text" placeholder="50" value={raw} onChange={(e) => setRaw(e.target.value)} className="w-28" />
            )}
            <Button type="submit" disabled={!chosen}>Set value</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr><Th>Entitlement</Th><Th>Type</Th><Th>Value</Th><Th>Actions</Th></Tr>
        </THead>
        <TBody>
          {values.map((v) => (
            <Tr key={v.entitlementId}>
              <Td className="font-mono text-xs">{v.key}</Td>
              <Td>{v.type}</Td>
              <Td>{String(v.value)}</Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  <Button variant="danger" size="sm" type="button" onClick={() => void remove(v.entitlementId)}>Remove</Button>
                </RequireRole>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
