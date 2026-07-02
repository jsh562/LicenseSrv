//! UniFFI surface (US3, P2, FR-003): a generated-binding entry point that reuses the **same**
//! shared [`crate::ls_ffi_verify`] and reason-code map — no per-language crypto (Principle III).
//! From this one surface UniFFI generates Python/Kotlin/Swift bindings. Compiled only under the
//! `uniffi` feature; declared in `lib.rs` as `#[path = "uniffi.rs"] mod uniffi_api` so the module
//! name does not shadow the `uniffi` crate.

use crate::{ls_ffi_verify, LsKeyring, VerifyInput};

/// A trusted public key (32 raw Ed25519 bytes) under a `key_id`, as passed from the host language.
#[derive(uniffi::Record)]
pub struct TrustedKey {
    pub key_id: String,
    pub public_key: Vec<u8>,
}

/// The outcome of one offline verification, mirroring the other bindings' reason code + reads.
#[derive(uniffi::Record)]
pub struct VerifyOutcome {
    /// Stable reason code: 0 = OK, else a frozen failure/misuse code (identical across bindings).
    pub code: u32,
    /// Whether the queried `entitlement` is enabled (bool true / int > 0) on a valid license.
    pub entitled: bool,
    /// The integer limit of the queried `entitlement`, or `None` if absent / not an integer.
    pub limit: Option<i64>,
    /// The anchor to persist after a successful verify, or `None` on failure.
    pub next_anchor: Option<i64>,
}

/// The packed ABI/format version (FR-012, FR-022); a host compares it at load to detect a mismatch.
#[uniffi::export]
pub fn abi_version() -> u32 {
    crate::ls_abi_version()
}

/// Verify a `LIC1` token fully offline (FR-003, FR-007) against `keys`, at host time `now_unix`,
/// and report whether `entitlement` is enabled and its integer limit. Wraps the one core verify,
/// so the reason `code` is identical to the C-ABI and WASM bindings for the same inputs.
#[uniffi::export]
pub fn verify_license(
    token: String,
    keys: Vec<TrustedKey>,
    now_unix: i64,
    entitlement: String,
) -> VerifyOutcome {
    let mut keyring = LsKeyring::empty();
    for k in &keys {
        if let Ok(bytes) = <[u8; 32]>::try_from(k.public_key.as_slice()) {
            keyring.add(&k.key_id, &bytes);
        }
        // A wrong-length key is simply not trusted; a token under it then fails as UnknownKey,
        // which is the correct, defined outcome (no panic, no crypto in the host language).
    }

    let result = ls_ffi_verify(&VerifyInput {
        token: &token,
        keyring: &keyring,
        now_unix,
        anchor_unix: None,
        fingerprint: None,
    });

    VerifyOutcome {
        code: result.code(),
        entitled: result.has(&entitlement),
        limit: result.limit(&entitlement),
        next_anchor: result.next_anchor(),
    }
}
