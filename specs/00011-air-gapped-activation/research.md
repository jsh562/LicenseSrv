# Research: Air-Gapped Activation via Signed Request/Response File Exchange

**Context**: PRODUCT-spec best practices for offline (zero-network) activation. Client SDK emits a REQUEST file;
an operator carries it to the online portal (consuming a SEAT via E009, signing via E004); portal returns a
SIGNED RESPONSE file the client imports and verifies offline via E001. Informs story priorities, success
criteria, and edge cases only.

## 1. Offline file-exchange pattern
**Recommend**: Mirror Keygen/Cryptlex/LimeLM. Client generates a REQUEST holding license key/id + machine
fingerprint (as hashes) + nonce + timestamp; portal returns a self-contained, cryptographically signed
RESPONSE (machine-bound token/certificate) that the client verifies with no callback. Treat the response as a
tamper-proof snapshot the offline device can validate standalone. **Avoid**: any response that requires a
server round-trip to validate, or activation state that lives only server-side.
### Sources
- https://github.com/keygen-sh/air-gapped-activation-example — reference request/response (fingerprint + key) flow
- https://docs.cryptlex.com/node-locked-licenses/offline-activations — operator uploads request, downloads signed response

## 2. Tamper-evidence & trust
**Recommend**: Anchor RESPONSE authenticity in the vendor Ed25519 signature; the offline client verifies it
against an embedded/pinned public key with zero network (reuse E001). Bind the token to the machine
fingerprint so a valid response only activates its target. Treat the REQUEST under an honest-client threat
model: the operator fully controls it, so never rely on request confidentiality/integrity for security —
enforce all invariants (seat cap, binding, nonce) server-side at processing. **Avoid**: trusting
request-supplied claims, or shipping a rotatable/unpinned verify key.
### Sources
- https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses/ — signed self-contained certificate verified against pinned key
- https://keygen.sh/docs/api/cryptography/ — Ed25519 signing of license/machine files for offline verification

## 3. Anti-replay & seat integrity
**Recommend**: Put a single-use nonce in the REQUEST; the portal store-and-checks it (E009 nonce store) so
re-submitting the same request is idempotent — it replays the original response and consumes NO second seat.
Add an optional freshness/expiry window on the request timestamp. Route the offline path through the SAME E009
seat accounting (race-safe cap, K-of-N binding) as online. Make dead air-gapped seat reclamation
operator/console-driven, since the machine cannot phone home to release. **Avoid**: minting a new seat per
resubmission, or auto-reclaiming offline seats on inactivity.
### Sources
- https://techcommunity.microsoft.com/blog/appsonazureblog/building-a-cryptographically-secure-product-licensing-system-on-azure-functions-/4351330 — nonce registry, consumed once within a validity window
- https://wyday.com/limelm/help/offline-activation/ — offline deactivation is an operator-driven request file

## 4. File format & versioning
**Recommend**: Use a versioned, portable envelope: compact base64/JSON with an explicit `format-version` field;
reject unknown/future versions with a distinct reason. Minimize PII — carry ONLY salted fingerprint hashes,
never raw hardware ids, in files or logs. Keep both files small and copy-pasteable (USB/email/QR-friendly).
Include an algorithm tag (e.g. `ed25519`) so verifiers self-describe. **Avoid**: unbounded blobs, raw device
identifiers, silent acceptance of unversioned files, or format drift between request and response.
### Sources
- https://keygen.sh/docs/api/cryptography/ — encoded certificate with version/algorithm header, base64 payload
- https://github.com/keygen-sh/air-gapped-activation-example — compact QR/file-portable encoding of key+fingerprint

## 5. Acceptance criteria & edge cases
**Recommend** the spec assert: (a) offline produce→import round-trip succeeds with zero network; (b) exactly
one seat consumed on first process; (c) seat-limit refusal returns NO response file (fail closed, distinct
reason); (d) resubmitting the same request is idempotent — returns the original response, no extra seat; (e)
tampered or wrong-machine response is REJECTED at import; (f) malformed, expired, or unknown-version request is
refused, each with a DISTINCT, testable reason. **Avoid**: partial-seat states on error, a generic single
error code, or accepting a response on a non-matching fingerprint.
### Sources
- https://docs.cryptlex.com/node-locked-licenses/offline-activations — response only issued for a valid request; explicit validity
- https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses/ — machine-bound, expiry-carrying, offline-verified certificate
