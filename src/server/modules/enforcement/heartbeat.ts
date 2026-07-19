// Heartbeat renewal (FR-002/003/004/017; US3; AD-001, {SAD:ADR-0010}). The periodic, silent renewal of the
// online-enforcement session validate established: the client beats at a cadence well below the short-token
// TTL (~50-70%, research), so a transient outage is absorbed by the grace window (FR-007) without a false
// lockout. A heartbeat is the SAME operation as a validate — resolve the E009 activation + E008 license,
// re-read the CURRENT effective entitlements (FR-017), evaluate the verdict, and ONLY when `valid` re-sign a
// fresh short-TTL LIC1 (advancing the monotonic last-seen anchor, FR-014). Because every beat RE-CHECKS
// status/expiry/entitlements with NO sticky state, a revoked/suspended/expired/deactivated binding stops
// renewing (200 + verdict, NO token — bounded staleness <= TTL) and a reinstated license resumes on the very
// next beat (FR-006). So it never duplicates the flow, it delegates to the shared `runEnforcement` core in
// validate.ts with `kind='heartbeat'` (the only difference is the audit action label, FR-019).
import type pg from "pg";

import type { EnforcementConfig } from "./config.js";
import type { Signer } from "../signing/signer.js";
import { runEnforcement, type EnforcementResult, type ValidateInput } from "./validate.js";

/**
 * Renew the short-lived token for a connected client before it expires (FR-003). Re-checks license status,
 * expiry, current effective entitlements (FR-017), and activation status this beat and, ONLY on `valid`,
 * mints a FRESH short-TTL LIC1 + advances the monotonic anchor (FR-014); a non-valid verdict refuses renewal
 * with a `200` + `verdict` and NO token (AD-001) so the outstanding token lapses within its TTL (FR-005). An
 * idempotent replay of the SAME nonce+activation returns the ORIGINAL result; a nonce reused for a DIFFERENT
 * activation throws `409 nonce_replayed`. Delegates to the shared `runEnforcement` flow — identical to
 * `validateOnline` save the audit action — so US1 and US3 can never drift apart.
 */
export async function heartbeatRenew(
  pool: pg.Pool,
  signer: Signer | undefined,
  config: EnforcementConfig,
  tenantId: string,
  input: ValidateInput,
): Promise<EnforcementResult> {
  return runEnforcement("heartbeat", pool, signer, config, tenantId, input);
}
