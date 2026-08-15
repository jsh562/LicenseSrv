// Domain / email-sender ownership verification (E018, US5; FR-013). The RESELLER plane: INITIATE a binding for a
// custom domain (DNS TXT/CNAME) or an email sender (SPF/DKIM/DMARC) — the response carries the PUBLIC DNS
// challenge to publish — then VERIFY (pending -> verified once the DNS proof is seen) and ACTIVATE (verified ->
// active for white-label; refused 409 not_verified until verified). A host already verified/active by another
// tenant is refused 409 binding_conflict on both verify and activate WITHOUT disclosing the holder. Initiate /
// verify / activate are admin-only (hidden from a viewer by RequireRole) and ride the double-submit CSRF token;
// the challenge is a public DNS value, never a secret.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, resellerApi, type DomainBinding, type DomainBindingKind, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

/** Map a verification ApiError to a human message, keeping the verify/conflict 409 codes explainable inline. */
function verifyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "not_verified":
        return "This host is not verified yet — publish the DNS challenge and verify before activating.";
      case "binding_conflict":
        return "That host is already verified or active for another tenant.";
      case "reseller_suspended":
        return "Your reseller account is suspended (read-only). Domain changes are blocked.";
      case "forbidden":
        return "Managing domains requires the admin role on a reseller account.";
      case "validation_error":
        return `Invalid request: ${err.message}`;
      default:
        return err.message || "The domain operation failed.";
    }
  }
  return "The domain operation failed.";
}

export function Domains({ sessionRole }: { sessionRole: Role }): JSX.Element {
  const [bindings, setBindings] = useState<DomainBinding[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kind, setKind] = useState<DomainBindingKind>("domain");
  const [host, setHost] = useState("");

  const refresh = useCallback(async () => {
    const res = await resellerApi.listDomains();
    setBindings(res.bindings);
    setTruncated(res.truncated);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load domain bindings."));
  }, [refresh]);

  async function initiate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!host.trim()) return;
    try {
      const b = await resellerApi.initiateDomain({ kind, host: host.trim() });
      setNotice(`Publish DNS challenge for ${b.host}: ${b.challenge}`);
      setHost("");
      await refresh();
    } catch (err) {
      setError(verifyErrorMessage(err));
    }
  }

  async function act(b: DomainBinding, action: "verify" | "activate"): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const updated =
        action === "verify"
          ? await resellerApi.verifyDomain(b.bindingId)
          : await resellerApi.activateDomain(b.bindingId);
      setNotice(`${updated.host} is now ${updated.status}.`);
      await refresh();
    } catch (err) {
      setError(verifyErrorMessage(err));
    }
  }

  return (
    <section aria-label="Domains">
      <h3>Custom domains &amp; email senders</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <form onSubmit={initiate} aria-label="Initiate verification">
          <select aria-label="Binding kind" value={kind} onChange={(e) => setKind(e.target.value as DomainBindingKind)}>
            <option value="domain">custom domain (DNS TXT/CNAME)</option>
            <option value="email_sender">email sender (SPF/DKIM/DMARC)</option>
          </select>
          <input
            aria-label="Host"
            placeholder="app.example.com or example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <button type="submit">Initiate verification</button>
        </form>
      </RequireRole>

      {truncated && <p role="status">Showing the first 1000 bindings (list truncated).</p>}
      {bindings.length === 0 ? (
        <p role="status">No domain bindings yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Host</th><th>Kind</th><th>Status</th><th>Challenge</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {bindings.map((b) => (
              <tr key={b.bindingId}>
                <td>{b.host}</td>
                <td>{b.kind}</td>
                <td>{b.status}</td>
                <td><code>{b.challenge}</code></td>
                <td>
                  <RequireRole role={sessionRole} min="admin">
                    <button type="button" aria-label={`Verify ${b.host}`} disabled={b.status !== "pending"} onClick={() => void act(b, "verify")}>Verify</button>
                    <button type="button" aria-label={`Activate ${b.host}`} disabled={b.status !== "verified"} onClick={() => void act(b, "activate")}>Activate</button>
                  </RequireRole>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
