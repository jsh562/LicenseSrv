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
    <section aria-label="Branding">
      <h3>White-label branding</h3>
      <label>
        Edit as{" "}
        <select aria-label="Branding mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="reseller">Reseller defaults &amp; locks</option>
          <option value="self">My branding</option>
        </select>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={save} aria-label="Edit branding">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                {mode === "reseller" && <th>Lock</th>}
              </tr>
            </thead>
            <tbody>
              {BRANDING_FIELD_NAMES.map((name) => {
                const isProviderLocked = mode === "self" && providerLocked.has(name);
                return (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>
                      <input
                        aria-label={`${name} value`}
                        value={fields[name] ?? ""}
                        disabled={isProviderLocked}
                        placeholder={isProviderLocked ? "set by your provider" : ""}
                        onChange={(e) => setField(name, e.target.value)}
                      />
                    </td>
                    {mode === "reseller" && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Lock ${name}`}
                          checked={locked.has(name)}
                          onChange={(e) => toggleLock(name, e.target.checked)}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button type="submit">Save branding</button>
        </form>
      </RequireRole>

      <div role="region" aria-label="Resolved branding">
        <h4>Applied (resolved) branding</h4>
        <table>
          <thead>
            <tr><th>Field</th><th>Value</th><th>Source</th><th>Locked</th></tr>
          </thead>
          <tbody>
            {resolved.map((r) => (
              <tr key={r.field}>
                <td>{r.field}</td>
                <td>{r.value ?? "—"}</td>
                <td>{r.source}</td>
                <td>{r.locked ? "set by your provider" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
