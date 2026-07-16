// Activation service (FR-001..009/021/023). Binds a machine to an active license under a race-safe seat
// lock and returns an offline-verifiable machine-bound credential. The whole decision runs in ONE tenant
// transaction holding `SELECT … FOR UPDATE` on the license row (AD-002/HINT-003), so N concurrent attempts
// for S free seats yield exactly S successes. A single-use nonce gives store-and-replay anti-replay
// (FR-009). The credential is signed AFTER the seat is secured, so a signer fault → 503 with no activation
// row (fail-closed, HINT-004). K-of-N drift (FR-005) re-uses the existing seat instead of consuming a new one.
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "../../audit/index.js";
import { withTenant, type TxQuery } from "../../db/client.js";
import { LICENSE_SELECT, mapLicenseRow } from "../issuance/licenses.js";
import type { Signer } from "../signing/signer.js";
import { SignerError } from "../signing/signer.js";
import { buildMachineClaims } from "./claims.js";
import { chooseMatch, deriveMachineId, type MatchCandidate } from "./fingerprint.js";
import { ActivationError, type ActivationConfig } from "./index.js";

const ACTOR = "activation-api";

export interface ActivateInput {
  licenseId?: string;
  licenseKey?: string;
  signals: string[];
  nonce: string;
  label?: string | null;
}

export interface ActivationResult {
  id: string;
  licenseId: string;
  machineId: string;
  status: "active";
  activatedAt: string;
  seatsUsed: number;
  seatLimit: number;
  machineBoundKey: string;
  /** true → a new seat was consumed (HTTP 201); false → a drift/nonce re-use of an existing seat (HTTP 200). */
  created: boolean;
}

interface CandidateRow {
  id: string;
  machine_id: string;
  signal_hashes: string[];
  updated_at: Date;
}

async function countActive(q: TxQuery, licenseId: string): Promise<number> {
  const r = await q("SELECT count(*)::int AS n FROM activation WHERE license_id = $1 AND status = 'active'", [licenseId]);
  return (r.rows[0] as { n: number }).n;
}

/**
 * Activate a machine against an active license. 400 insufficient_signals (< K signals); 404
 * license_not_found; 409 license_not_active / seat_limit_reached / nonce_replayed; 503 signer_unavailable
 * (no activation created). Returns the activation metadata plus the signed machine-bound credential.
 */
export async function activate(
  pool: pg.Pool,
  signer: Signer | undefined,
  config: ActivationConfig,
  tenantId: string,
  input: ActivateInput,
): Promise<ActivationResult> {
  if (input.signals.length < config.fpMin) {
    throw new ActivationError("insufficient_signals", 400, `at least ${config.fpMin} signals are required to bind a machine`);
  }
  if (!signer) throw new ActivationError("signer_unavailable", 503, "no signer is configured");

  const machineId = deriveMachineId(input.signals, config.activationSalt);
  const nowUnix = Math.floor(Date.now() / 1000);

  return withTenant(pool, tenantId, async (q): Promise<ActivationResult> => {
    // Resolve + row-lock the license (by id, or by its stored token). The lock serializes all
    // activation/deactivation for this license so the seat count cannot be raced.
    let licenseId = input.licenseId;
    if (!licenseId) {
      const lr = await q("SELECT id FROM license WHERE license_token = $1", [input.licenseKey]);
      if (!lr.rowCount) throw new ActivationError("license_not_found", 404, "unknown license");
      licenseId = (lr.rows[0] as { id: string }).id;
    }
    const lockRes = await q(`SELECT ${LICENSE_SELECT} FROM license WHERE id = $1 FOR UPDATE`, [licenseId]);
    if (!lockRes.rowCount) throw new ActivationError("license_not_found", 404, "unknown license");
    const license = mapLicenseRow(lockRes.rows[0]);

    // FR-008: only an active, unexpired license accepts new activations.
    const expired = license.expiresAt != null && new Date(license.expiresAt).getTime() <= Date.now();
    if (license.status !== "active" || expired) {
      throw new ActivationError("license_not_active", 409, "the license is suspended, revoked, or expired");
    }

    // FR-009 nonce store-and-replay: a reused nonce for the same (license, machine) replays the original
    // result; a nonce reused to forge a different activation is rejected.
    const priorNonce = await q(
      "SELECT id, license_id, machine_id, activated_at, machine_bound_token FROM activation WHERE nonce = $1",
      [input.nonce],
    );
    if (priorNonce.rowCount) {
      const row = priorNonce.rows[0] as { id: string; license_id: string; machine_id: string; activated_at: Date; machine_bound_token: string | null };
      if (row.license_id === licenseId && row.machine_id === machineId) {
        return {
          id: row.id, licenseId, machineId, status: "active", activatedAt: row.activated_at.toISOString(),
          seatsUsed: await countActive(q, licenseId), seatLimit: license.maxActivations,
          machineBoundKey: row.machine_bound_token ?? "", created: false,
        };
      }
      throw new ActivationError("nonce_replayed", 409, "this nonce has already been used");
    }

    // FR-005 K-of-N: does the incoming fingerprint re-match an existing active machine on this license?
    const activeRes = await q(
      "SELECT id, machine_id, signal_hashes, updated_at FROM activation WHERE license_id = $1 AND status = 'active'",
      [licenseId],
    );
    const candidates: MatchCandidate[] = (activeRes.rows as CandidateRow[]).map((r) => ({
      id: r.id, machineId: r.machine_id, signalHashes: r.signal_hashes, updatedAt: r.updated_at.toISOString(),
    }));
    const match = chooseMatch(input.signals, machineId, candidates, config.fpMin);

    // New machine → enforce the seat cap under the lock (FR-003/004): no partial activation past the limit.
    if (!match && candidates.length >= license.maxActivations) {
      throw new ActivationError("seat_limit_reached", 409, "the seat limit has been reached", {
        seatLimit: license.maxActivations, seatsUsed: candidates.length,
      });
    }

    // Mint the machine-bound credential now that the seat is secured. A signer fault rolls the tx back →
    // 503 with no activation row (fail-closed).
    const claims = buildMachineClaims({
      license, signalHashes: input.signals, fpMin: config.fpMin,
      maxSkewSecs: config.maxSkewSecs, nowUnix, credentialTtlSecs: config.credentialTtlSecs,
    });
    let token: string;
    try {
      token = await signer.sign(tenantId, claims);
    } catch (e) {
      if (e instanceof SignerError) throw new ActivationError("signer_unavailable", 503, `signer unavailable (${e.failure})`);
      throw e;
    }

    try {
      if (match) {
        // Re-activation (drift or same machine): refresh in place — same seat, new credential (FR-005).
        const upd = await q(
          `UPDATE activation
             SET machine_id = $2, signal_hashes = $3, fp_min = $4, nonce = $5, machine_bound_token = $6,
                 label = COALESCE($7, label), updated_at = now()
           WHERE id = $1 RETURNING id, activated_at`,
          [match.id, machineId, input.signals, config.fpMin, input.nonce, token, input.label ?? null],
        );
        const row = upd.rows[0] as { id: string; activated_at: Date };
        await writeAudit(q, { actor: ACTOR, action: "activation.refreshed", target: match.id, after: { licenseId, machineId } });
        return {
          id: row.id, licenseId, machineId, status: "active", activatedAt: row.activated_at.toISOString(),
          seatsUsed: await countActive(q, licenseId), seatLimit: license.maxActivations,
          machineBoundKey: token, created: false,
        };
      }

      const id = randomUUID();
      const ins = await q(
        `INSERT INTO activation (id, tenant_id, license_id, machine_id, signal_hashes, fp_min, nonce, machine_bound_token, label)
         VALUES ($1, current_setting('app.current_tenant')::uuid, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, activated_at`,
        [id, licenseId, machineId, input.signals, config.fpMin, input.nonce, token, input.label ?? null],
      );
      const row = ins.rows[0] as { id: string; activated_at: Date };
      await writeAudit(q, { actor: ACTOR, action: "activation.created", target: id, after: { licenseId, machineId } });
      return {
        id: row.id, licenseId, machineId, status: "active", activatedAt: row.activated_at.toISOString(),
        seatsUsed: await countActive(q, licenseId), seatLimit: license.maxActivations,
        machineBoundKey: token, created: true,
      };
    } catch (e) {
      // A concurrent request that grabbed the same nonce (different license → not serialized by our lock).
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
        throw new ActivationError("nonce_replayed", 409, "this nonce has already been used");
      }
      throw e;
    }
  });
}
