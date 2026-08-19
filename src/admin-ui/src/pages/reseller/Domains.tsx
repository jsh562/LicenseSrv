// Domain / email-sender ownership verification (E018, US5; FR-013). The RESELLER plane: INITIATE a binding for a
// custom domain (DNS TXT/CNAME) or an email sender (SPF/DKIM/DMARC) — the response carries the PUBLIC DNS
// challenge to publish — then VERIFY (pending -> verified once the DNS proof is seen) and ACTIVATE (verified ->
// active for white-label; refused 409 not_verified until verified). A host already verified/active by another
// tenant is refused 409 binding_conflict on both verify and activate WITHOUT disclosing the holder. Initiate /
// verify / activate are admin-only (hidden from a viewer by RequireRole) and ride the double-submit CSRF token;
// the challenge is a public DNS value, never a secret.
import { useState, type FormEvent } from "react";

import { ApiError, resellerApi, type DomainBinding, type DomainBindingKind, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";
import { Badge, statusTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../../components/ui/Table";
import { useAsync } from "../../hooks/useAsync";

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
  const { data, reload, error: loadError } = useAsync(() => resellerApi.listDomains(), []);
  const bindings = data?.bindings ?? [];
  const truncated = data?.truncated ?? false;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kind, setKind] = useState<DomainBindingKind>("domain");
  const [host, setHost] = useState("");

  async function initiate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!host.trim()) return;
    try {
      const b = await resellerApi.initiateDomain({ kind, host: host.trim() });
      setNotice(`Publish DNS challenge for ${b.host}: ${b.challenge}`);
      setHost("");
      await reload();
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
      await reload();
    } catch (err) {
      setError(verifyErrorMessage(err));
    }
  }

  return (
    <section aria-label="Domains" className="space-y-4">
      <PageHeader title="Custom domains & email senders" description="Verify and activate the domains and email senders used for white-labeled communications (DNS + SPF/DKIM/DMARC)." />
      {Boolean(error || loadError) && (
        <p role="alert" className="error text-sm text-danger">
          {error ?? "Could not load domain bindings."}
        </p>
      )}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}

      <RequireRole role={sessionRole} min="admin">
        <Card>
          <form onSubmit={initiate} aria-label="Initiate verification" className="flex flex-wrap items-end gap-3">
            <Select aria-label="Binding kind" value={kind} onChange={(e) => setKind(e.target.value as DomainBindingKind)} className="w-72">
              <option value="domain">custom domain (DNS TXT/CNAME)</option>
              <option value="email_sender">email sender (SPF/DKIM/DMARC)</option>
            </Select>
            <Input
              aria-label="Host"
              placeholder="app.example.com or example.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="w-64"
            />
            <Button type="submit">Initiate verification</Button>
          </form>
        </Card>
      </RequireRole>

      {truncated && <p role="status" className="text-sm text-fg-muted">Showing the first 1000 bindings (list truncated).</p>}
      {bindings.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">No domain bindings yet.</p>
      ) : (
        <Table>
          <THead>
            <Tr><Th>Host</Th><Th>Kind</Th><Th>Status</Th><Th>Challenge</Th><Th>Actions</Th></Tr>
          </THead>
          <TBody>
            {bindings.map((b) => (
              <Tr key={b.bindingId}>
                <Td>{b.host}</Td>
                <Td>{b.kind}</Td>
                <Td><Badge tone={statusTone(b.status)}>{b.status}</Badge></Td>
                <Td><code className="font-mono text-xs">{b.challenge}</code></Td>
                <Td>
                  <RequireRole role={sessionRole} min="admin">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="sm" type="button" aria-label={`Verify ${b.host}`} disabled={b.status !== "pending"} onClick={() => void act(b, "verify")}>Verify</Button>
                      <Button variant="secondary" size="sm" type="button" aria-label={`Activate ${b.host}`} disabled={b.status !== "verified"} onClick={() => void act(b, "activate")}>Activate</Button>
                    </div>
                  </RequireRole>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
