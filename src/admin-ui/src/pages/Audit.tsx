// Audit view (US5, FR-015). A read-only table over the append-only audit log with from/to,
// security-events-only, and actor filters, plus cursor "Load more" paging. There is deliberately no
// create/edit/delete affordance — the log is immutable and this view only ever reads.
import { useCallback, useEffect, useState } from "react";

import { adminApi, type AuditEntry, type AuditQuery } from "../api";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Field";
import { PageHeader } from "../components/ui/PageHeader";
import { Table, TBody, Td, Th, THead, Tr } from "../components/ui/Table";

export function Audit(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actor, setActor] = useState("");
  const [securityOnly, setSecurityOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildQuery = useCallback(
    (append: string | null): AuditQuery => ({
      from: from || undefined,
      to: to || undefined,
      actor: actor.trim() || undefined,
      securityEvent: securityOnly || undefined,
      cursor: append || undefined,
    }),
    [from, to, actor, securityOnly],
  );

  const load = useCallback(
    async (append: string | null) => {
      setError(null);
      try {
        const page = await adminApi.listAudit(buildQuery(append));
        setEntries((cur) => (append ? [...cur, ...page.entries] : page.entries));
        setCursor(page.nextCursor);
      } catch {
        setError("Could not load audit entries.");
      }
    },
    [buildQuery],
  );

  useEffect(() => {
    void load(null);
    // Initial load only; subsequent loads are driven by Apply/Load more.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-label="Audit log" className="space-y-4">
      <PageHeader title="Audit Log" description="Immutable, append-only record of workspace activity." />
      {error && (
        <p role="alert" className="error text-sm text-danger">
          {error}
        </p>
      )}

      <Card>
        <form
          aria-label="Audit filters"
          onSubmit={(e) => {
            e.preventDefault();
            void load(null);
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <Field label="From">
            <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="w-52" />
          </Field>
          <Field label="To">
            <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="w-52" />
          </Field>
          <Field label="Actor">
            <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="actor id" className="w-48" />
          </Field>
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={securityOnly}
              onChange={(e) => setSecurityOnly(e.target.checked)}
            />
            Security events only
          </label>
          <Button type="submit">Apply</Button>
        </form>
      </Card>

      <Table>
        <THead>
          <Tr>
            <Th>Timestamp</Th>
            <Th>Actor</Th>
            <Th>Action</Th>
            <Th>Target</Th>
            <Th>Security</Th>
          </Tr>
        </THead>
        <TBody>
          {entries.map((e) => (
            <Tr key={e.id}>
              <Td className="font-mono text-xs">{e.ts}</Td>
              <Td>{e.actor}</Td>
              <Td>{e.action}</Td>
              <Td>{e.target ?? "—"}</Td>
              <Td>{e.securityEvent ? <Badge tone="warning">yes</Badge> : ""}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      {cursor && (
        <Button variant="secondary" type="button" onClick={() => void load(cursor)}>
          Load more
        </Button>
      )}
    </section>
  );
}
