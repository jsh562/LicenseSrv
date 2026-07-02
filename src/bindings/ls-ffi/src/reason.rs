//! The single, frozen reason-code map shared by **every** binding (FR-006, FR-022).
//!
//! There is exactly one place a `verifier-core` outcome becomes an integer; the C ABI, WASM,
//! and UniFFI bindings all call [`reason_code`] so the same failure yields the same number
//! everywhere. The integers below are an **external contract**: once shipped they are frozen,
//! and any change is a breaking ABI change requiring a binding major-version bump
//! (see [`crate::ls_abi_version`] / `REASON_SET_REV`).
//!
//! ## Frozen reason codes (single source of truth)
//!
//! | Code | Name | Meaning |
//! |------|------|---------|
//! | 0   | `OK`                  | Verification succeeded. |
//! | 1   | `MALFORMED`           | Token bytes/structure invalid (`VerifyError::Malformed`). |
//! | 2   | `UNSUPPORTED_VERSION` | Token envelope/version not supported. |
//! | 3   | `UNKNOWN_KEY`         | `key_id` not in the trusted keyring. |
//! | 4   | `KEY_NOT_VALID`       | Selected key revoked or outside its validity window. |
//! | 5   | `BAD_SIGNATURE`       | Ed25519 signature did not verify. |
//! | 6   | `EXPIRED`             | License past its `expires_at`. |
//! | 7   | `CLOCK_ROLLBACK`      | Clock rolled back / future-dated token (anti-rollback). |
//! | 8   | `FINGERPRINT_MISMATCH`| Machine fingerprint did not match K-of-N. |
//! | 9   | `FINGERPRINT_MISSING` | License is machine-bound but no fingerprint supplied. |
//! | 253 | `UNMAPPED`            | A future core variant not yet mapped (must be assigned before ship). |
//! | 254 | `BAD_ARGUMENT`        | Null/invalid handle or malformed host input (FR-016); not a verify outcome. |
//! | 255 | `INTERNAL`            | Caught panic or non-unwinding fault (FR-005); not a verify outcome. |
//!
//! Codes carry **no** secret or diagnostic detail (FR-006/FR-014): they distinguish failure
//! categories (tampered vs expired vs malformed) without exposing crypto internals.

use verifier_core::VerifyError;

/// Verification succeeded.
pub const OK: u32 = 0;

/// A future `VerifyError` variant that has not yet been assigned a stable code. The core enum is
/// `#[non_exhaustive]`; if it gains a variant, that variant MUST be mapped explicitly in
/// [`reason_code`] (and `REASON_SET_REV` bumped) before a binding ships. Surfacing a distinct
/// `253` rather than silently reusing another code makes an unmapped variant detectable.
pub const UNMAPPED: u32 = 253;

/// Null or invalid handle, or malformed host input (e.g. non-UTF-8 token) — FR-016. This is a
/// *misuse* signal, deliberately distinct from any genuine verification outcome.
pub const BAD_ARGUMENT: u32 = 254;

/// A panic was caught at the FFI boundary, or a non-unwinding fault occurred (FR-005). Distinct
/// from every verification outcome so a host can tell "the verifier faulted" from "the license
/// is invalid".
pub const INTERNAL: u32 = 255;

/// Map a closed-set [`VerifyError`] to its frozen stable integer (FR-006).
///
/// The match is exhaustive over today's variants; the `#[non_exhaustive]` wildcard returns
/// [`UNMAPPED`] so a newly-added core variant is caught in tests rather than silently aliased.
pub fn reason_code(err: &VerifyError) -> u32 {
    match err {
        VerifyError::Malformed => 1,
        VerifyError::UnsupportedVersion => 2,
        VerifyError::UnknownKey => 3,
        VerifyError::KeyNotValid => 4,
        VerifyError::BadSignature => 5,
        VerifyError::Expired => 6,
        VerifyError::ClockRollback => 7,
        VerifyError::FingerprintMismatch => 8,
        VerifyError::FingerprintMissing => 9,
        // VerifyError is #[non_exhaustive]; a future variant is UNMAPPED until assigned here.
        _ => UNMAPPED,
    }
}
