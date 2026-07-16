// T006 (FR-005/016/019): the pure K-of-N fingerprint logic — canonical machine-id derivation (salt-rotation
// sensitive), signal overlap, and the deterministic re-match choice (exact id > highest overlap ≥ K > most-recent).
import { describe, expect, it } from "vitest";

import { chooseMatch, deriveMachineId, type MatchCandidate, overlapCount } from "../fingerprint.js";

describe("deriveMachineId", () => {
  it("is stable regardless of signal order and duplicates", () => {
    expect(deriveMachineId(["a", "b", "c"], "salt")).toBe(deriveMachineId(["c", "b", "a", "a"], "salt"));
  });
  it("changes when the salt rotates (FR-019)", () => {
    expect(deriveMachineId(["a", "b"], "salt-1")).not.toBe(deriveMachineId(["a", "b"], "salt-2"));
  });
});

describe("overlapCount", () => {
  it("counts the shared signal hashes", () => {
    expect(overlapCount(["a", "b", "c"], ["b", "c", "d"])).toBe(2);
    expect(overlapCount(["a"], ["x"])).toBe(0);
  });
});

describe("chooseMatch (FR-005)", () => {
  const cand = (id: string, machineId: string, signalHashes: string[], updatedAt: string): MatchCandidate => ({ id, machineId, signalHashes, updatedAt });

  it("prefers an exact machine_id match", () => {
    const m = chooseMatch(["a", "b", "c"], "M1", [cand("1", "M1", ["a", "b", "c"], "2026-01-01T00:00:00Z"), cand("2", "M2", ["a", "b", "c"], "2026-02-01T00:00:00Z")], 3);
    expect(m?.id).toBe("1");
  });
  it("matches on >= K overlap when no exact id matches (drift tolerance)", () => {
    const m = chooseMatch(["a", "b", "c", "x"], "MX", [cand("1", "M1", ["a", "b", "c", "y"], "2026-01-01T00:00:00Z")], 3);
    expect(m?.id).toBe("1"); // 3 of 4 shared >= K
  });
  it("returns null below K (a new machine)", () => {
    const m = chooseMatch(["a", "b", "z"], "MZ", [cand("1", "M1", ["a", "x", "y"], "2026-01-01T00:00:00Z")], 3);
    expect(m).toBeNull(); // only 1 shared < 3
  });
  it("breaks ties by most-recently-active", () => {
    const m = chooseMatch(["a", "b", "c"], "MX", [cand("old", "M1", ["a", "b", "c"], "2026-01-01T00:00:00Z"), cand("new", "M2", ["a", "b", "c"], "2026-06-01T00:00:00Z")], 3);
    expect(m?.id).toBe("new");
  });
});
