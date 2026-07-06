// Audit view (US5, FR-015). A read-only table over the append-only audit log with from/to,
// security-events-only, and actor filters, plus cursor "Load more" paging. There is deliberately no
// create/edit/delete affordance — the log is immutable and this view only ever reads.
import { useCallback, useEffect, useState } from "react";

import { adminApi, type AuditEntry, type AuditQuery } from "../api";

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
    <section aria-label="Audit log">
      <h2>Audit Log</h2>
      {error && <p role="alert" className="error">{error}</p>}

      <form
        aria-label="Audit filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load(null);
        }}
      >
        <label>
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Actor
          <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="actor id" />
        </label>
        <label>
          <input
            type="checkbox"
            checked={securityOnly}
            onChange={(e) => setSecurityOnly(e.target.checked)}
          />
          Security events only
        </label>
        <button type="submit">Apply</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>Security</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{e.ts}</td>
              <td>{e.actor}</td>
              <td>{e.action}</td>
              <td>{e.target ?? "—"}</td>
              <td>{e.securityEvent ? "yes" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {cursor && (
        <button type="button" onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
    </section>
  );
}
