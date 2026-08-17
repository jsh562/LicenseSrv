// Entitlements view (US3, FR-015; E016 FR-008). Lists feature entitlements and lets an admin define a boolean,
// integer-limit, or METERED entitlement (aggregation type + unit + optional allowance) and archive one. The key
// becomes the feature key embedded in issued licenses. For a metered kind the aggregation/unit/allowance fields
// appear; the server (assertMeteredShape) is the authoritative validator (counter-only, unit required).
import { useState, type FormEvent } from "react";

import {
  ApiError,
  catalogApi,
  type EntitlementKind,
  type MeteredAggregation,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

export function Entitlements({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const { data: entitlements = [], reload, error: loadError } = useAsync(() => catalogApi.listEntitlements("all"), []);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<EntitlementKind>("boolean");
  const [aggregation, setAggregation] = useState<MeteredAggregation>("sum");
  const [unit, setUnit] = useState("");
  const [allowance, setAllowance] = useState("");
  const [error, setError] = useState<string | null>(null);

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
      await reload();
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
      await reload();
    } catch {
      setError("Archive failed.");
    }
  }

  return (
    <section aria-label="Entitlements" className="space-y-4">
      <PageHeader title="Entitlements" />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load entitlements."}
        </p>
      )}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={create} aria-label="Create entitlement" className="flex flex-wrap items-end gap-3">
            <Input aria-label="Entitlement key" placeholder="export-pdf" value={key} onChange={(e) => setKey(e.target.value)} required className="w-40" />
            <Input aria-label="Entitlement name" placeholder="Export PDF" value={name} onChange={(e) => setName(e.target.value)} required className="w-40" />
            <Select aria-label="Entitlement type" value={type} onChange={(e) => setType(e.target.value as EntitlementKind)} className="w-40">
              <option value="boolean">boolean</option>
              <option value="integer_limit">integer_limit</option>
              <option value="metered">metered</option>
            </Select>
            {type === "metered" && (
              <>
                <Select aria-label="Aggregation" value={aggregation} onChange={(e) => setAggregation(e.target.value as MeteredAggregation)} className="w-40">
                  <option value="sum">sum</option>
                  <option value="count">count</option>
                  <option value="unique_count">unique_count</option>
                </Select>
                <Input aria-label="Unit" placeholder="gb" value={unit} onChange={(e) => setUnit(e.target.value)} required className="w-28" />
                <Input aria-label="Allowance" type="number" min="0" placeholder="allowance (optional)" value={allowance} onChange={(e) => setAllowance(e.target.value)} className="w-44" />
              </>
            )}
            <Button type="submit">Add entitlement</Button>
          </form>
        </Card>
      </RequireRole>

      <Table>
        <THead>
          <Tr><Th>Key</Th><Th>Name</Th><Th>Type</Th><Th>Aggregation</Th><Th>Unit</Th><Th>Allowance</Th><Th>Status</Th><Th>Actions</Th></Tr>
        </THead>
        <TBody>
          {entitlements.map((e) => (
            <Tr key={e.id}>
              <Td className="font-mono text-xs">{e.key}</Td>
              <Td>{e.name}</Td>
              <Td>{e.type}</Td>
              <Td>{e.aggregation ?? "-"}</Td>
              <Td>{e.unit ?? "-"}</Td>
              <Td>{e.allowance ?? "-"}</Td>
              <Td><Badge tone={statusTone(e.status)}>{e.status}</Badge></Td>
              <Td>
                <RequireRole role={sessionRole} min="admin">
                  {e.status === "active" && (
                    <Button variant="danger" size="sm" type="button" onClick={() => void archive(e.id)}>Archive</Button>
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
