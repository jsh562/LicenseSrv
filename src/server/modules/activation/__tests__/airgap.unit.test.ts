// T002/T009 (E010 FR-001/006/007/010/014/019): the pure air-gap file codec — encode/decode round-trip, the
// pre-decode oversize guard, format-version rejection, and structural/reference validation. Freshness + the
// seat flow need the DB and live in airgap.integration.test.ts.
import { describe, expect, it } from "vitest";

import { decodeRequestFile, encodeResponseFile, type RequestEnvelope, type ResponseEnvelope } from "../airgap.js";
import { ActivationError, loadActivationConfig } from "../index.js";

const config = loadActivationConfig({}); // defaults: req version "airgap-req-1", max 64 KiB
const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const req = (over: Partial<RequestEnvelope> = {}): Record<string, unknown> => ({
  formatVersion: "airgap-req-1",
  licenseId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  fingerprint: { signals: ["hash-1", "hash-2", "hash-3"] },
  nonce: "n".repeat(32),
  producedAt: "2026-07-16T00:00:00.000Z",
  ...over,
});

function expectCode(fn: () => unknown, code: string): ActivationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ActivationError);
    expect((e as ActivationError).code).toBe(code);
    return e as ActivationError;
  }
  throw new Error("expected the call to throw");
}

describe("decodeRequestFile (FR-001/007/014/019)", () => {
  it("round-trips a valid request envelope", () => {
    const env = decodeRequestFile(enc(req()), config);
    expect(env.licenseId).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(env.fingerprint.signals).toEqual(["hash-1", "hash-2", "hash-3"]);
    expect(env.formatVersion).toBe("airgap-req-1");
  });

  it("refuses an oversize file before decoding, with reason=oversize (FR-019)", () => {
    const big = "A".repeat(config.airgapMaxRequestBytes + 1);
    const e = expectCode(() => decodeRequestFile(big, config), "validation_error");
    expect(e.details).toMatchObject({ reason: "oversize" });
  });

  it("refuses a malformed (non-decodable) file (FR-007)", () => {
    expectCode(() => decodeRequestFile("not-a-valid-envelope-$$$", config), "validation_error");
  });

  it("refuses an unknown/future format version (FR-014)", () => {
    const e = expectCode(() => decodeRequestFile(enc(req({ formatVersion: "airgap-req-99" })), config), "unknown_format_version");
    expect(e.details).toMatchObject({ formatVersion: "airgap-req-99" });
  });

  it("refuses a structurally invalid envelope (no signals)", () => {
    expectCode(() => decodeRequestFile(enc(req({ fingerprint: { signals: [] } })), config), "validation_error");
  });

  it("refuses both or neither license reference", () => {
    expectCode(() => decodeRequestFile(enc(req({ licenseKey: "LIC1.x" })), config), "validation_error"); // both id+key
    expectCode(() => decodeRequestFile(enc({ ...req(), licenseId: undefined }), config), "validation_error"); // neither
  });

  it("refuses a too-short nonce (< 128-bit floor)", () => {
    expectCode(() => decodeRequestFile(enc(req({ nonce: "short" })), config), "validation_error");
  });
});

describe("encodeResponseFile (FR-006)", () => {
  it("produces a base64url envelope that decodes back byte-identically", () => {
    const resp: ResponseEnvelope = { formatVersion: "airgap-resp-1", activationId: "a1", machineBoundKey: "LIC1.abc", keyId: null, expiresAt: null, machineId: "m1" };
    const file = encodeResponseFile(resp);
    expect(JSON.parse(Buffer.from(file, "base64url").toString("utf8"))).toEqual(resp);
    // determinism: same envelope → identical bytes (byte-identical replay, FR-005)
    expect(encodeResponseFile(resp)).toBe(file);
  });
});
