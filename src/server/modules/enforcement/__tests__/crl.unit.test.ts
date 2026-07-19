// T033 [US4] (FR-022): the CRL canonical encoding is DETERMINISTIC (stable ordering → byte-stable signing
// input), the published `version` is strictly monotonic (max+1), and a client anti-downgrade check rejects
// an older signed version. Pure — no DB, no signer, no crypto: it exercises the byte-stability contract the
// detached signature relies on (`buildCanonicalCrlBytes`) plus the `isFresherCrlVersion` guard.
import { describe, expect, it } from "vitest";

import {
  buildCanonicalCrlBytes,
  type CrlDocument,
  isFresherCrlVersion,
  serializeCrlArtifact,
  type RevocationListRecord,
} from "../crl.js";

const baseDoc = (over: Partial<CrlDocument> = {}): CrlDocument => ({
  version: 7,
  generatedAt: "2026-07-18T00:00:00.000Z",
  nextUpdate: "2026-07-19T00:00:00.000Z",
  revokedIds: {
    licenses: ["e5f60718-3333-4c4d-ae5f-60718293a4b5", "f6071829-4444-4d5e-bf60-718293a4b5c6"],
    activations: ["a7f1c2d3-9a8b-4c7d-8e1f-0a1b2c3d4e5f"],
  },
  ...over,
});

describe("buildCanonicalCrlBytes — deterministic, byte-stable encoding (FR-022)", () => {
  it("produces identical bytes for the same logical document (a signature over it is byte-stable)", () => {
    const a = buildCanonicalCrlBytes(baseDoc());
    const b = buildCanonicalCrlBytes(baseDoc());
    expect(a.equals(b)).toBe(true);
  });

  it("is INVARIANT to the input array order — the id sets are sorted before encoding", () => {
    const sorted = buildCanonicalCrlBytes(baseDoc());
    const shuffled = buildCanonicalCrlBytes(
      baseDoc({
        revokedIds: {
          licenses: ["f6071829-4444-4d5e-bf60-718293a4b5c6", "e5f60718-3333-4c4d-ae5f-60718293a4b5"],
          activations: ["a7f1c2d3-9a8b-4c7d-8e1f-0a1b2c3d4e5f"],
        },
      }),
    );
    expect(shuffled.equals(sorted)).toBe(true);
  });

  it("does not mutate the caller's id arrays while sorting", () => {
    const doc = baseDoc({ revokedIds: { licenses: ["b", "a"], activations: ["y", "x"] } });
    buildCanonicalCrlBytes(doc);
    expect(doc.revokedIds.licenses).toEqual(["b", "a"]); // untouched
    expect(doc.revokedIds.activations).toEqual(["y", "x"]);
  });

  it("changes the bytes when any signed field changes (the signature would no longer verify)", () => {
    const base = buildCanonicalCrlBytes(baseDoc());
    expect(buildCanonicalCrlBytes(baseDoc({ version: 8 })).equals(base)).toBe(false);
    expect(buildCanonicalCrlBytes(baseDoc({ nextUpdate: "2026-07-20T00:00:00.000Z" })).equals(base)).toBe(false);
    expect(
      buildCanonicalCrlBytes(baseDoc({ revokedIds: { licenses: ["e5f60718-3333-4c4d-ae5f-60718293a4b5"], activations: [] } })).equals(base),
    ).toBe(false);
  });

  it("encodes the signed subset only — the same content yields the same bytes across records", () => {
    // The canonical signing input is `{version,generatedAt,nextUpdate,revokedIds}` and nothing else.
    const bytes = buildCanonicalCrlBytes(baseDoc());
    const text = bytes.toString("utf8");
    expect(text).toContain('"version":7');
    expect(text).not.toContain("keyId");
    expect(text).not.toContain("signature");
    expect(text).not.toContain("productId");
  });
});

describe("serializeCrlArtifact — byte-identical json/file body over the signed content", () => {
  it("is deterministic and carries the public signature + keyId around the signed document", () => {
    const record: RevocationListRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      productId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      version: 7,
      generatedAt: "2026-07-18T00:00:00.000Z",
      nextUpdate: "2026-07-19T00:00:00.000Z",
      keyId: "k-abc",
      signature: "c2ln",
      revokedIds: { licenses: ["b", "a"], activations: [] },
    };
    const first = serializeCrlArtifact(record);
    const second = serializeCrlArtifact(record);
    expect(first).toBe(second); // identical bytes → json and file forms are byte-identical
    const parsed = JSON.parse(first) as { version: number; keyId: string; signature: string; revokedIds: { licenses: string[] } };
    expect(parsed.version).toBe(7);
    expect(parsed.keyId).toBe("k-abc");
    expect(parsed.signature).toBe("c2ln");
    expect(parsed.revokedIds.licenses).toEqual(["a", "b"]); // sorted
  });
});

describe("version monotonicity + anti-downgrade (FR-022)", () => {
  it("max(version)+1 is strictly increasing (the generation-tx rule, modeled here)", () => {
    const nextVersion = (existing: number[]): number => existing.reduce((m, v) => Math.max(m, v), 0) + 1;
    expect(nextVersion([])).toBe(1); // first publication
    expect(nextVersion([1])).toBe(2);
    expect(nextVersion([1, 2, 3])).toBe(4);
    // A gap is tolerated; monotone increase is what matters.
    expect(nextVersion([1, 5])).toBe(6);
  });

  it("isFresherCrlVersion accepts a strictly newer version and rejects an older/equal one", () => {
    expect(isFresherCrlVersion(null, 1)).toBe(true); // client holds none yet
    expect(isFresherCrlVersion(41, 42)).toBe(true); // newer → apply
    expect(isFresherCrlVersion(42, 42)).toBe(false); // equal → ignore
    expect(isFresherCrlVersion(42, 41)).toBe(false); // OLDER signed version → anti-downgrade reject
  });
});
