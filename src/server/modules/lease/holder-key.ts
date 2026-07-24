// Holder-key derivation (E015, FR-020/023/026; ADR-0012 AD-005/AD-006). A lease's holder is identified ONLY
// by a pseudonymous `holder_key` — a SALTED HASH of a CLIENT-SUPPLIED opaque reference, scoped per the
// plan's concurrency_scope. The RAW reference and any raw hardware signal are NEVER stored, logged, or
// returned (FR-001/FR-020/SC-015). [COMPLETES FR-026]
//
//   * session (default) — keyed on the client-supplied per-instance `reference`.
//   * user              — keyed on a named-user `reference`.
//   * machine           — keyed on the E009 device fingerprint (client-computed salted per-signal hashes),
//                         folded into a single canonical identity exactly like E009's deriveMachineId, so
//                         instances on one machine share a seat (FR-023).
//
// The salt is the SERVER-HELD, per-tenant/product holder-key salt (FR-026) — provisioned via config and
// NEVER distributed to the client (unlike E009's SDK activation salt, since floating is online and the salt
// + hash is computed SERVER-side). The scope is folded into the digest so the SAME string under a different
// scope yields a DIFFERENT holder key (domain separation). A salt rotation disturbs no LIVE lease (renew/
// release operate on the stored row); only NEW acquires derive under the rotated salt (INV-8).
import { createHash } from "node:crypto";

import type { ConcurrencyScope } from "./config.js";

/** The inputs to {@link deriveHolderKey}. Exactly one of `reference` / `signals` is authoritative per scope. */
export interface HolderKeyParams {
  scope: ConcurrencyScope;
  /** The client-supplied opaque holder reference (authoritative for `session`/`user`; supplemental for `machine`). */
  reference: string;
  /** The E009 machine-fingerprint signal hashes (authoritative for `machine`; ignored otherwise). */
  signals?: string[] | null;
}

/** Thrown when the inputs required for the configured scope are missing (surfaced by acquire as 400). */
export class HolderKeyError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "HolderKeyError";
  }
}

const base64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Fold the machine fingerprint into a single canonical identity: the DE-DUPLICATED, SORTED signal-hash set
 * joined by `|` — the same canonicalization E009 uses (`deriveMachineId`), so a `machine`-scope holder-key is
 * stable across signal reordering and shared by instances on one machine (FR-023).
 */
function canonicalMachine(signals: string[]): string {
  return [...new Set(signals)].sort().join("|");
}

/**
 * Derive the pseudonymous `holder_key` (a 32-byte SHA-256 digest) for a lease, salted with the server-held
 * per-tenant salt and domain-separated by scope (FR-020/023/026). The raw reference / raw signals never
 * appear in the output — the digest is one-way. Returns the raw digest as a Buffer (stored as `bytea`);
 * {@link holderKeyToString} renders the pseudonymous wire form. Throws {@link HolderKeyError} when a required
 * input for the scope is missing (e.g. no fingerprint under `machine` scope → 400 validation_error, FR-023).
 */
export function deriveHolderKey(params: HolderKeyParams, salt: string): Buffer {
  let canonical: string;
  if (params.scope === "machine") {
    const signals = params.signals ?? [];
    if (signals.length === 0) {
      throw new HolderKeyError("fingerprint", "A fingerprint is required under machine concurrency scope.");
    }
    canonical = canonicalMachine(signals);
  } else {
    const reference = params.reference ?? "";
    if (reference.length === 0) {
      throw new HolderKeyError("holderReference", "A holder reference is required under session/user concurrency scope.");
    }
    canonical = reference;
  }
  // salt ‖ scope ‖ canonical — the scope is inside the digest so the same string counts distinctly per scope.
  return createHash("sha256").update(`${salt}:${params.scope}:${canonical}`).digest();
}

/** Render a `holder_key` digest as the pseudonymous, URL-safe wire string returned to callers / the registry. */
export function holderKeyToString(key: Buffer): string {
  return base64url(key);
}
