//! T014 (FR-006): the reason-code map is total, stable, and frozen. Every `VerifyError` variant
//! maps to its documented integer; the codes are distinct; misuse/internal codes never collide
//! with verify outcomes. This is the contract a binding integrator and any cross-binding parity
//! test rely on (FR-022).

use ls_ffi::reason::{reason_code, BAD_ARGUMENT, INTERNAL, OK, UNMAPPED};
use verifier_core::VerifyError;

/// Pinned (variant, code) pairs. If the core appends a variant, this test must be extended and
/// `REASON_SET_REV` bumped — that is the intended trip-wire (the map is an external contract).
const FROZEN: &[(VerifyError, u32)] = &[
    (VerifyError::Malformed, 1),
    (VerifyError::UnsupportedVersion, 2),
    (VerifyError::UnknownKey, 3),
    (VerifyError::KeyNotValid, 4),
    (VerifyError::BadSignature, 5),
    (VerifyError::Expired, 6),
    (VerifyError::ClockRollback, 7),
    (VerifyError::FingerprintMismatch, 8),
    (VerifyError::FingerprintMissing, 9),
];

#[test]
fn every_variant_maps_to_its_frozen_integer() {
    for (variant, expected) in FROZEN {
        assert_eq!(
            reason_code(variant),
            *expected,
            "{variant:?} must map to the frozen code {expected}"
        );
        // A real verify outcome is never confused with success or a misuse/internal signal.
        assert_ne!(reason_code(variant), OK);
        assert_ne!(reason_code(variant), UNMAPPED);
        assert_ne!(reason_code(variant), BAD_ARGUMENT);
        assert_ne!(reason_code(variant), INTERNAL);
    }
}

#[test]
fn failure_codes_are_distinct() {
    let mut codes: Vec<u32> = FROZEN.iter().map(|(v, _)| reason_code(v)).collect();
    codes.sort_unstable();
    let count = codes.len();
    codes.dedup();
    assert_eq!(codes.len(), count, "every failure maps to a distinct code");
}

#[test]
fn reserved_codes_are_pinned() {
    // Frozen sentinels — changing any of these is a breaking ABI change.
    assert_eq!(OK, 0);
    assert_eq!(UNMAPPED, 253);
    assert_eq!(BAD_ARGUMENT, 254);
    assert_eq!(INTERNAL, 255);
}
