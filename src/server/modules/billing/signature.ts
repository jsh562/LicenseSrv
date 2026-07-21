// Webhook signature verification (FR-002; AD-001, HINT-001). The provider authenticates each webhook with
// an HMAC-SHA256 over `${timestamp}.${rawBody}` carried in a Stripe-style signature header
// (`t=<unix>,v1=<hex>[,v1=<hex>...]`). We recompute the HMAC over the RAW request bytes and compare in
// CONSTANT TIME (`crypto.timingSafeEqual`) against the connection's CURRENT secret and -- during a rotation
// transition window -- the PREVIOUS secret, then enforce timestamp recency (reject stale AND future skew).
// Verification happens BEFORE any JSON parse or side effect: a failure is rejected inline with no ledger
// row and no state change. No secret or signature is ever echoed back.
import crypto from "node:crypto";

/** The reason a signature verification failed. `mismatch`/`missing`/`malformed` → 401; `*_timestamp` → 400. */
export type SignatureFailure = "missing" | "malformed" | "mismatch" | "stale_timestamp" | "future_timestamp";

export interface SignatureResult {
  ok: boolean;
  /** Set only when `ok` is false. */
  reason?: SignatureFailure;
  /** The parsed signed timestamp (epoch seconds), when the header parsed. */
  timestamp?: number;
  /** True when the match was against the PREVIOUS (rotation-window) secret rather than the current one. */
  usedPrevious?: boolean;
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[]; // all v1 candidates (a rotated endpoint may carry several)
}

/**
 * Parse a Stripe-style signature header `t=<unix>,v1=<hex>[,v1=<hex>...]` (also tolerates `v0`/extra parts,
 * which are ignored). Returns null when there is no numeric `t` or no `v1` candidate.
 */
export function parseSignatureHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const t = Number(value);
      if (Number.isFinite(t)) timestamp = Math.floor(t);
    } else if (key === "v1" && value) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** HMAC-SHA256 of `${timestamp}.${rawBody}` under `secret`, as raw bytes (the signed-payload scheme). */
function computeHmac(secret: Buffer | string, timestamp: number, rawBody: Buffer): Buffer {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${timestamp}.`);
  h.update(rawBody);
  return h.digest();
}

/** Constant-time compare of `expected` (raw HMAC bytes) against a hex candidate. Length-guarded, never throws. */
function constantTimeMatch(expected: Buffer, candidateHex: string): boolean {
  let candidate: Buffer;
  try {
    candidate = Buffer.from(candidateHex, "hex");
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, candidate);
}

/** Does any provided `v1` candidate match the HMAC computed under `secret`? Constant-time per candidate. */
function anyMatch(secret: Buffer | string, header: ParsedHeader, rawBody: Buffer): boolean {
  const expected = computeHmac(secret, header.timestamp, rawBody);
  let matched = false;
  // Iterate every candidate (do not short-circuit the timingSafeEqual work) to keep the per-candidate
  // compare constant-time; the OR is folded after each compare.
  for (const sig of header.signatures) matched = constantTimeMatch(expected, sig) || matched;
  return matched;
}

/**
 * Verify a provider webhook signature (FR-002). Recomputes the HMAC over the RAW body and compares in
 * constant time against `secretCurrent` first, then `secretPrev` (when supplied — the rotation transition
 * window), then enforces timestamp recency within `toleranceSecs` (rejecting BOTH stale and future skew).
 *
 * Evaluation order (matches the webhook plane): signature match BEFORE timestamp recency, so a forged body
 * is `mismatch` (401) rather than leaking a timestamp verdict; a genuinely-signed but out-of-tolerance
 * delivery is `stale_timestamp` / `future_timestamp` (400). Returns `{ ok: true, timestamp, usedPrevious }`
 * on success. Never throws; never echoes the secret or signature.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined | null,
  secretCurrent: Buffer | string,
  secretPrev: Buffer | string | undefined | null,
  nowUnix: number,
  toleranceSecs: number,
): SignatureResult {
  if (!header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };

  let matched = anyMatch(secretCurrent, parsed, rawBody);
  let usedPrevious = false;
  if (!matched && secretPrev != null && (typeof secretPrev !== "string" || secretPrev.length > 0)) {
    if (anyMatch(secretPrev, parsed, rawBody)) {
      matched = true;
      usedPrevious = true;
    }
  }
  if (!matched) return { ok: false, reason: "mismatch", timestamp: parsed.timestamp };

  const skew = nowUnix - parsed.timestamp; // >0 = the event is in the past
  if (skew > toleranceSecs) return { ok: false, reason: "stale_timestamp", timestamp: parsed.timestamp };
  if (-skew > toleranceSecs) return { ok: false, reason: "future_timestamp", timestamp: parsed.timestamp };

  return { ok: true, timestamp: parsed.timestamp, usedPrevious };
}
