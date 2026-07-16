// Activations view (US4, FR-012). Shows one license's activation registry — its bound machines (pseudonymous
// machine identity, status, timestamps) and a seats-used-vs-limit summary — and lets an admin reclaim a seat
// by deactivating an active machine. The machine-bound credential and raw signals are never shown (the server
// never returns them). Reclaim is hidden from viewers by RequireRole; the server enforces RBAC regardless.
import { useCallback, useEffect, useState } from "react";

import { activationApi, type Activation, type License, type Role } from "../../api";
import { RequireRole } from "../../components/RequireRole";

export function Activations({ license, sessionRole, onBack }: { license: License; sessionRole: Role; onBack: () => void }): JSX.Element {
  const [activations, setActivations] = useState<Activation[]>([]);
  const [seats, setSeats] = useState<{ used: number; limit: number }>({ used: 0, limit: license.maxActivations });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const reg = await activationApi.listActivations(license.id);
    setActivations(reg.activations);
    setSeats({ used: reg.seatsUsed, limit: reg.seatLimit });
  }, [license.id]);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load activations."));
  }, [refresh]);

  async function reclaim(activationId: string): Promise<void> {
    setError(null);
    try {
      await activationApi.reclaim(license.id, activationId);
      await refresh();
    } catch {
      setError("Could not reclaim the seat.");
    }
  }

  return (
    <section aria-label="Activations">
      <button type="button" onClick={onBack}>← Licenses</button>
      <h3>Activations for {license.id}</h3>
      <p>{`Seats used ${seats.used} / ${seats.limit}`}</p>
      {error && <p role="alert" className="error">{error}</p>}

      <table>
        <thead>
          <tr><th>Machine</th><th>Status</th><th>Activated</th><th>Deactivated</th><th>Label</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {activations.map((a) => (
            <tr key={a.id}>
              <td>{a.machineId}</td>
              <td>{a.status}</td>
              <td>{a.activatedAt}</td>
              <td>{a.deactivatedAt ?? "—"}</td>
              <td>{a.label ?? "—"}</td>
              <td>
                <RequireRole role={sessionRole} min="admin">
                  {a.status === "active" && (
                    <button type="button" onClick={() => void reclaim(a.id)}>Reclaim seat</button>
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
