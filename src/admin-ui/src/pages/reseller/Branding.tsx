// White-label branding editor (E018, US2; FR-006/007/008/014). TWO modes over the SAME 8 contract branding
// fields (trust signals are NEVER branding fields, FR-008):
//   * "Reseller defaults & locks" (RESELLER plane) — set the reseller's own field values and LOCK any field; a
//     locked field becomes authoritative for every sub-tenant. Resolved = reseller value -> platform default.
//   * "My branding" (SUB-TENANT plane) — set this tenant's own OVERRIDES; a field its provider LOCKED is shown
//     NON-EDITABLE ("set by your provider") and an override attempt is refused 409 field_locked WITHOUT revealing
//     the reseller (the hierarchy is never disclosed downward). Resolved = override -> reseller default ->
//     platform, per field independently.
// Editing is admin-only (hidden from a viewer by RequireRole) and rides the double-submit CSRF token; the server
// enforces the plane + RBAC + CSRF + the lock set fail-closed regardless of what the SPA shows.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  BRANDING_FIELD_NAMES,
  resellerApi,
  type BrandingFieldName,
  type BrandingFields,
  type ResolvedField,
  type Role,
} from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";

type Mode = "reseller" | "self";

/** Map a branding ApiError to a human message, keeping the lock / verify 409 codes explainable inline. */
function brandingErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "field_locked":
        return "That field is set by your provider and cannot be overridden.";
      case "not_verified":
        return "A custom domain / email sender must be verified and activated before it can be applied.";
      case "reseller_suspended":
        return "Your reseller account is suspended (read-only). Branding changes are blocked.";
      case "forbidden":
        return "Editing branding requires the admin role.";
      case "validation_error":
        return `Invalid request: ${err.message}`;
      default:
        return err.message || "Could not save branding.";
    }
  }
  return "Could not save branding.";
}

export function Branding({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [mode, setMode] = useState<Mode>("reseller");
  const [fields, setFields] = useState<BrandingFields>({});
  const [locked, setLocked] = useState<Set<BrandingFieldName>>(new Set());
  // In "self" mode, the fields the PROVIDER locked (non-editable here) — hierarchy-concealed, no reseller identity.
  const [providerLocked, setProviderLocked] = useState<Set<BrandingFieldName>>(new Set());
  const [resolved, setResolved] = useState<ResolvedField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (m: Mode) => {
    setError(null);
    setNotice(null);
    try {
      if (m === "reseller") {
        const b = await resellerApi.getResellerBranding();
        setFields(b.fields);
        setLocked(new Set(b.locked));
        setProviderLocked(new Set());
        setResolved(b.resolved);
      } else {
        const b = await resellerApi.getBranding();
        setFields(b.overrides);
        setLocked(new Set());
        setProviderLocked(new Set(b.lockedFields));
        setResolved(b.resolved);
      }
    } catch (err) {
      setError(brandingErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load(mode);
  }, [load, mode]);

  function setField(name: BrandingFieldName, value: string): void {
    setFields((prev) => {
      const next = { ...prev };
      if (value.trim() === "") delete next[name];
      else next[name] = value;
      return next;
    });
  }

  function toggleLock(name: BrandingFieldName, on: boolean): void {
    setLocked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      if (mode === "reseller") {
        const b = await resellerApi.setResellerBranding({ fields, locked: [...locked] });
        setResolved(b.resolved);
        setNotice("Reseller branding + locks saved.");
      } else {
        const b = await resellerApi.setBranding(fields);
        setResolved(b.resolved);
        setNotice("Branding overrides saved.");
      }
    } catch (err) {
      setError(brandingErrorMessage(err));
    }
  }

  return (
    <section aria-label="Branding" className="space-y-4">
      <PageHeader title="White-label branding" />
      <label className="inline-flex items-center gap-2 text-sm font-medium">
        Edit as
        <Select aria-label="Branding mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="w-64">
          <option value="reseller">Reseller defaults &amp; locks</option>
          <option value="self">My branding</option>
        </Select>
      </label>
      {error && <p role="alert" className="error text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={save} aria-label="Edit branding" className="space-y-3">
            <Table>
              <THead>
                <Tr>
                  <Th>Field</Th>
                  <Th>Value</Th>
                  {mode === "reseller" && <Th>Lock</Th>}
                </Tr>
              </THead>
              <TBody>
                {BRANDING_FIELD_NAMES.map((name) => {
                  const isProviderLocked = mode === "self" && providerLocked.has(name);
                  return (
                    <Tr key={name}>
                      <Td className="font-medium">{name}</Td>
                      <Td>
                        <Input
                          aria-label={`${name} value`}
                          value={fields[name] ?? ""}
                          disabled={isProviderLocked}
                          placeholder={isProviderLocked ? "set by your provider" : ""}
                          onChange={(e) => setField(name, e.target.value)}
                        />
                      </Td>
                      {mode === "reseller" && (
                        <Td>
                          <input
                            type="checkbox"
                            aria-label={`Lock ${name}`}
                            checked={locked.has(name)}
                            onChange={(e) => toggleLock(name, e.target.checked)}
                            className="h-4 w-4 accent-primary"
                          />
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
            <Button type="submit">Save branding</Button>
          </form>
        </Card>
      </RequireRole>

      <div role="region" aria-label="Resolved branding" className="space-y-2">
        <h4 className="font-medium">Applied (resolved) branding</h4>
        <Table>
          <THead>
            <Tr><Th>Field</Th><Th>Value</Th><Th>Source</Th><Th>Locked</Th></Tr>
          </THead>
          <TBody>
            {resolved.map((r) => (
              <Tr key={r.field}>
                <Td className="font-medium">{r.field}</Td>
                <Td>{r.value ?? "—"}</Td>
                <Td>{r.source}</Td>
                <Td>{r.locked ? "set by your provider" : "—"}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
    </section>
  );
}
