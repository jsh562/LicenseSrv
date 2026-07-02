# Signing-Key Recovery Runbook (E004, TR-013 / SC-008)

Covers custody, backup separation, and recovery for the per-product Ed25519 signing keys. The
signing key is the platform's tier-0 secret — its custody model is designed so that **no single
backup can reconstruct a private key**.

## Custody model

- Each product's **private** signing key is stored only as an AES-256-GCM **wrapped blob** in
  `signing_key.private_key_ref` (custody scheme `keystore-aes256gcm-v1`). No column, API response,
  or log ever holds an unwrapped private key (TR-001/TR-010).
- The wrapping **master key** is never persisted. At boot it is reconstructed **in memory** from a
  Shamir **k-of-n** custodian split of the unlock material (TR-012). Below `k` shares the signer
  stays **locked** and refuses to sign (fail-closed, TR-011); readiness (not liveness) reports
  not-ready.

## Backup separation (the SC-008 invariant)

Two backups exist and **MUST be stored separately, under different custody**:

1. **Database backup** — contains `signing_key` rows, i.e. the *wrapped* private blobs. Useless
   alone: without the master key the blobs cannot be decrypted.
2. **Custodian shares** — the Shamir shares of the master-key unlock material, distributed to `n`
   custodians (e.g. offline hardware, sealed envelopes, separate secret managers). Any `k` of them
   reconstruct the master key.

Neither backup alone can reconstruct a private key. Recovery requires the database backup **and**
at least `k` custodian shares — the SC-008 acceptance condition.

## Recovery procedure

1. Restore the PostgreSQL backup (wrapped blobs intact).
2. Gather **≥ k** custodian shares from distinct custodians.
3. Provide the shares to the runtime via the E006 secrets contract
   (`SIGNING_CUSTODIAN_SHARES`, comma-separated base64) — injected as env/secret files, never baked
   into an image (IP-006).
4. Start the service. The signer reconstructs the master key in memory, unlocks, and
   `GET /internal/ready/signing` returns `200`. If fewer than `k` shares are supplied it stays
   locked and returns `503` — supply the missing shares.
5. Verify a mint end-to-end (issue a test license and confirm it verifies offline via a binding).

## Rotation & compromise

- **Suspected key compromise**: revoke the affected `key_id` (removed from the published keyring,
  never signed with again; audit retained) and rotate to a new active key. Prior licenses under
  still-trusted keys keep verifying during the overlap window.
- **Custodian change**: re-split the master key into a fresh k-of-n set and redistribute; destroy
  the old shares.
- **Never** email, log, or store shares together with the database backup.
