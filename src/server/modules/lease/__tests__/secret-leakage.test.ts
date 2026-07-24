// T040 [COMPLETES FR-020] (SC-015): the hard secrecy boundary of the lease surface. NONE of the following ever
// survives into a response body, a log line (captured in-memory pino, like billing), or an audit entry:
//   • the E004 signing PRIVATE key material (only the OPAQUE keyId + PUBLIC LEASE1 handle are exposed),
//   • the RAW client-supplied holder reference (only its pseudonymous salted-hash `holderKey`),
//   • the server-held holder-key SALT (FR-026/SC-023 — never distributed to a client),
//   • a RAW hardware identifier (the machine-scope fingerprint signals),
//   • card / PAN data (embedded here in the holder reference, hashed away).
// The lease row stores ONLY the pseudonymous holder-key (bytea); the response carries only holderKey + the
// public handle + the opaque keyId. Uses the real Testcontainers + real-signer harness with in-memory LOG
// CAPTURE and a distinctive server-held salt canary.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "../../../db/client.js";
import { activeKey } from "../../signing/registry.js";
import { startHarness, type LeaseHarness } from "./harness.js";

// Distinctive canary tokens (long, unambiguous — cannot collide with UUID/timestamp/base64-hash noise).
const PAN = "4111111111111111"; // classic test PAN — must be hashed away, never stored/logged
const CVV = "CVVCANARY737";
const EXPIRY = "EXPCANARY1229";
const CARDHOLDER = "CARDHOLDER_CANARY";
/** The RAW client-supplied holder reference — embeds a PAN, so it doubles as a card-data canary. */
const RAW_HOLDER = `rawholderref_CANARY_${PAN}_instance_8f2Xk`;
/** RAW hardware-fingerprint signals (machine scope) — a raw hardware identifier that must never leak. */
const RAW_HW_A = "RAWHWID_CANARY_serial_ABCDEF0123456789";
const RAW_HW_B = "RAWHWID_CANARY_mac_00DEADBEEF11";
/** The server-held holder-key salt (FR-026) — a secret that must NEVER appear anywhere (SC-023). */
const SALT_CANARY = "LEASE_SALT_CANARY_do_not_leak_9f8Xk2QpL0rNvT7";

let h: LeaseHarness;
/** The wrapped E004 signing private-key material read from the keystore — must never leak. */
let privateKeyRefB64 = "";
/** All response bodies produced by the exercised operations (JSON strings), scanned for canaries. */
const responseBodies: string[] = [];
/** The session-scope acquire grant (for the positive-shape + handle-decode assertions). */
let sessionGrant: Record<string, unknown> = {};

/** Every secret/PII canary that MUST be absent from any response, log line, or audit entry. */
function canaries(): string[] {
  return [RAW_HOLDER, RAW_HW_A, RAW_HW_B, PAN, CVV, EXPIRY, CARDHOLDER, SALT_CANARY, privateKeyRefB64];
}

beforeAll(async () => {
  h = await startHarness("secret-leak", { captureLogs: true, holderKeySalt: SALT_CANARY });

  // The wrapped signing private key from the keystore (never plaintext, never exposed) — a canary to prove no
  // key material reaches a response/log/audit entry.
  const key = await activeKey(h.pool, h.tenantA, h.productId);
  privateKeyRefB64 = (key?.privateKeyRef ?? Buffer.alloc(0)).toString("base64");

  // 1) session-scope acquire with a canary-stuffed holder reference (embeds a PAN).
  const sessionLic = await h.issueFloating({ maxConcurrent: 3, scope: "session" });
  const sAcq = await h.acquire(h.leaseKey, { licenseId: sessionLic.licenseId, holderReference: RAW_HOLDER, acquireToken: h.nonce() });
  if (sAcq.statusCode !== 201) throw new Error(`session acquire failed: ${sAcq.statusCode} ${sAcq.body}`);
  responseBodies.push(sAcq.body);
  sessionGrant = sAcq.json() as Record<string, unknown>;
  const sessionLeaseId = sessionGrant.id as string;

  // 2) machine-scope acquire with RAW hardware-fingerprint signals.
  const machineLic = await h.issueFloating({ maxConcurrent: 3, scope: "machine" });
  const mAcq = await h.acquire(h.leaseKey, {
    licenseId: machineLic.licenseId,
    holderReference: "machine-holder-benign-ref",
    acquireToken: h.nonce(),
    fingerprint: { signals: [RAW_HW_A, RAW_HW_B] },
  });
  if (mAcq.statusCode !== 201) throw new Error(`machine acquire failed: ${mAcq.statusCode} ${mAcq.body}`);
  responseBodies.push(mAcq.body);
  const machineLeaseId = (mAcq.json() as { id: string }).id;

  // 3) renew (refreshes the handle) + 4) admin force-release + 5) a reclaim sweep — more response/audit surface.
  responseBodies.push((await h.renew(h.leaseKey, sessionLeaseId)).body);
  responseBodies.push((await h.admin("POST", `/admin/leases/${machineLeaseId}/force-release`)).body);
  await h.expireLease(sessionLeaseId);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

describe("lease secret leakage — no key / raw holder / salt / raw hardware / card data anywhere (FR-020, SC-015)", () => {
  it("no canary secret appears in ANY response body; only holderKey + public handle + opaque keyId are exposed", () => {
    for (const body of responseBodies) {
      for (const secret of canaries()) expect(body).not.toContain(secret);
    }

    // Positive shape: the session grant carries a PSEUDONYMOUS holderKey (not the raw ref), a PUBLIC LEASE1
    // handle, and an OPAQUE keyId — and nothing else identifying.
    expect(typeof sessionGrant.holderKey).toBe("string");
    expect(sessionGrant.holderKey).not.toBe(RAW_HOLDER);
    expect(String(sessionGrant.holderKey)).not.toContain(PAN);
    expect(typeof sessionGrant.leaseHandle).toBe("string");
    expect((sessionGrant.leaseHandle as string).startsWith("LEASE1.")).toBe(true);
    expect(typeof sessionGrant.keyId).toBe("string");
    expect(sessionGrant.keyId).not.toBe(privateKeyRefB64);
  });

  it("the signed handle carries only pseudonymous claims — never the raw holder reference / hardware id / card data", () => {
    const parts = (sessionGrant.leaseHandle as string).split(".");
    expect(parts.length).toBe(3);
    const payload = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(payload) as Record<string, unknown>;
    // The holder claim is the SAME pseudonymous holderKey the response exposes — never the raw reference.
    expect(claims.hk).toBe(sessionGrant.holderKey);
    const claimsJson = JSON.stringify(claims);
    for (const secret of canaries()) expect(claimsJson).not.toContain(secret);
  });

  it("no secret reaches the lease row or the append-only audit log (raw ref/signal never stored)", async () => {
    // The lease row stores holder_key as an opaque bytea hash (rendered base64 here) — never the raw ref/signals.
    const leaseScan = await withTenant(h.pool, h.tenantA, (q) =>
      q("SELECT id, encode(holder_key,'base64') AS holder_key, concurrency_scope, status, nonce, activation_id, handle_key_id, overage FROM lease"),
    );
    const leaseJson = JSON.stringify(leaseScan.rows);
    for (const secret of canaries()) expect(leaseJson).not.toContain(secret);

    // The append-only audit log (every op + denial + reclaim) carries only ids/counts — no secret material.
    const auditScan = await withTenant(h.pool, h.tenantA, (q) => q("SELECT to_jsonb(audit_log) AS row FROM audit_log"));
    const auditJson = JSON.stringify(auditScan.rows);
    for (const secret of canaries()) expect(auditJson).not.toContain(secret);
  });

  it("no secret reaches a log line (in-memory pino capture)", async () => {
    // Emit a known marker through the app logger — pino writes it synchronously into the capture stream, proving
    // capture is wired (independent of async request-log flush timing).
    h.app.log.info({ probe: "lease-secret-leakage-capture-marker" }, "log capture probe");
    await new Promise((r) => setImmediate(r)); // let any pending async request-log lines flush into the buffer

    const logs = h.logs();
    expect(logs).toContain("lease-secret-leakage-capture-marker"); // sanity: capture is actually wired
    for (const secret of canaries()) expect(logs).not.toContain(secret);
  });
});
