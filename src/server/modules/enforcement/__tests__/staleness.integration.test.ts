// T028 [US5] (FR-013; SC-006): the bounded revocation-staleness window is disclosed IN-BAND. Every
// validate/heartbeat response carries `stalenessWindow` = max(short-token TTL, CRL nextUpdate) + offline
// tolerance — the honestly-disclosed worst-case delay between an admin revocation and its enforcement. The
// online path also never mutates the E009 `machine_bound_token` (the short-lived token is a SEPARATE public
// artifact). Real Postgres via Testcontainers + the real E004 signer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CRL_NEXT_UPDATE_SECS,
  DEFAULT_OFFLINE_TOLERANCE_SECS,
  DEFAULT_RENEWAL_WINDOW_SECS,
} from "../config.js";
import { startHarness, type EnforcementHarness } from "./harness.js";

let h: EnforcementHarness;

beforeAll(async () => {
  h = await startHarness("staleness");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

interface Staleness {
  seconds: number;
  tokenTtlSeconds: number;
  crlNextUpdateSeconds: number;
  offlineToleranceSeconds: number;
}
interface Wire {
  verdict: string;
  shortLivedToken?: string;
  stalenessWindow: Staleness;
}

function assertFormula(sw: Staleness): void {
  // FR-013: seconds = max(tokenTtl, crlNextUpdate) + offlineTolerance — the disclosed formula, in-band.
  expect(sw.seconds).toBe(Math.max(sw.tokenTtlSeconds, sw.crlNextUpdateSeconds) + sw.offlineToleranceSeconds);
  // The concrete deployment defaults (harness leaves the window config at its documented defaults).
  expect(sw.tokenTtlSeconds).toBe(DEFAULT_RENEWAL_WINDOW_SECS);
  expect(sw.crlNextUpdateSeconds).toBe(DEFAULT_CRL_NEXT_UPDATE_SECS);
  expect(sw.offlineToleranceSeconds).toBe(DEFAULT_OFFLINE_TOLERANCE_SECS);
  expect(sw.seconds).toBe(Math.max(DEFAULT_RENEWAL_WINDOW_SECS, DEFAULT_CRL_NEXT_UPDATE_SECS) + DEFAULT_OFFLINE_TOLERANCE_SECS);
}

describe("bounded-staleness disclosure (integration, real Postgres + real signer)", () => {
  it("US5: validate + heartbeat both disclose the stalenessWindow formula in-band (SC-006)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("z1", "z2", "z3", "z4", "z5");
    const { activationId } = await h.activateMachine(lic.id, fp);

    const v = (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    expect(v.verdict).toBe("valid");
    assertFormula(v.stalenessWindow);

    const hb = (await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    expect(hb.verdict).toBe("valid");
    assertFormula(hb.stalenessWindow);
  });

  it("US5: validate/heartbeat never mutate the E009 machine_bound_token (separate public artifact)", async () => {
    const lic = await h.issueLicense();
    const fp = h.sigs("y1", "y2", "y3", "y4", "y5");
    const { activationId, machineBoundKey } = await h.activateMachine(lic.id, fp);
    const before = await h.activationRow(activationId);

    const v = (await h.validate(h.validateKey, { activationId, nonce: h.nonce() })).json() as Wire;
    // The short-lived renewal token is a DIFFERENT artifact from the long-lived offline credential.
    expect(v.shortLivedToken).toBeDefined();
    expect(v.shortLivedToken).not.toBe(machineBoundKey);

    await h.heartbeat(h.validateKey, { activationId, nonce: h.nonce() });

    // The stored machine_bound_token is byte-for-byte unchanged after both a validate and a heartbeat.
    const after = await h.activationRow(activationId);
    expect(after!.machineBoundToken).toBe(before!.machineBoundToken);
    expect(after!.machineBoundToken).toBe(machineBoundKey);
  });
});
