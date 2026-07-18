// Fingerprint matching (FR-005/006/016). A machine is identified ONLY by salted hashes — the client
// computes per-signal salted hashes locally with a provisioned salt (FR-019) and sends the hashes; the
// server never sees raw hardware identifiers (FR-006). `deriveMachineId` folds the sorted signal set into
// a single canonical identity (also salted, so a salt rotation changes it → prior fingerprints stop
// matching, FR-019). A returning machine re-matches an existing activation when it shares at least K of N
// signals (K-of-N drift tolerance), with a deterministic tie-break so re-activation is unambiguous.
import { saltedHash } from "../../db/hash.js";
/** Canonical machine identity: a salted hash of the de-duplicated, sorted signal-hash set (FR-006). */
export function deriveMachineId(signalHashes, salt) {
    const canonical = [...new Set(signalHashes)].sort().join("|");
    return saltedHash(canonical, salt);
}
/** How many signal hashes two fingerprints share (the K-of-N overlap, FR-005). */
export function overlapCount(a, b) {
    const setB = new Set(b);
    let n = 0;
    for (const s of new Set(a))
        if (setB.has(s))
            n++;
    return n;
}
/**
 * Choose the active activation a returning machine re-matches (FR-005): an exact `machine_id` match wins
 * first; otherwise the candidate sharing the most signals, provided the overlap is at least `k`; ties are
 * broken by the most-recently-active row (`updated_at`). Returns null when the machine matches nothing
 * (a new machine that must consume its own seat).
 */
export function chooseMatch(incomingSignals, machineId, candidates, k) {
    const exact = candidates.find((c) => c.machineId === machineId);
    if (exact)
        return exact;
    let best = null;
    let bestOverlap = 0;
    for (const c of candidates) {
        const o = overlapCount(incomingSignals, c.signalHashes);
        if (o < k)
            continue;
        if (o > bestOverlap || (o === bestOverlap && best !== null && c.updatedAt > best.updatedAt)) {
            best = c;
            bestOverlap = o;
        }
    }
    return best;
}
