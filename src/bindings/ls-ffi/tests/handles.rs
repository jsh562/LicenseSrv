//! T016 (FR-008, FR-015, FR-016): the opaque-handle memory-ownership contract.
//! - allocate/free balance across many cycles;
//! - `*_free(null)` is a defined no-op (the detectable double-free surface);
//! - a null handle yields `BAD_ARGUMENT`, never a null dereference;
//! - handles round-trip through the typed verify entry and read entitlements.

mod common;

use ls_ffi::reason::{BAD_ARGUMENT, OK};
use ls_ffi::{
    boxed_result, check_keyring_ptr, free_keyring, free_result, ls_ffi_verify, LsKeyring,
    VerifyInput,
};

#[test]
fn alloc_then_free_is_balanced_over_many_cycles() {
    for _ in 0..1_000 {
        let kr = LsKeyring::boxed();
        assert!(!kr.is_null(), "boxed() must return a live handle");
        // SAFETY: kr is a live handle from this crate, freed exactly once.
        unsafe { free_keyring(kr) };
    }
}

#[test]
fn free_null_is_a_defined_noop() {
    // The detectable double-free guard: after the host nulls its pointer post-free (per the
    // ownership contract), a subsequent free is a no-op rather than UB.
    unsafe {
        free_keyring(std::ptr::null_mut());
        free_result(std::ptr::null_mut());
    }
}

#[test]
fn null_handle_yields_bad_argument_not_a_crash() {
    // SAFETY: null is an explicitly allowed input to the guard.
    let code = unsafe { check_keyring_ptr(std::ptr::null()) };
    assert_eq!(code, BAD_ARGUMENT);
}

#[test]
fn valid_handle_passes_the_null_guard() {
    let kr = LsKeyring::boxed();
    // SAFETY: kr is a live, non-null handle.
    let code = unsafe { check_keyring_ptr(kr) };
    assert_eq!(code, OK);
    unsafe { free_keyring(kr) };
}

#[test]
fn adding_an_invalid_public_key_is_bad_argument() {
    // Roughly half of all 32-byte strings are not decompressable Ed25519 points; find one the
    // core itself rejects so the assertion does not depend on a guessed magic constant.
    let bogus = (0u32..100_000)
        .map(|seed| {
            let mut b = [0u8; 32];
            b[..4].copy_from_slice(&seed.to_le_bytes());
            b
        })
        .find(|b| verifier_core::VerifyingKey::from_bytes(b).is_err())
        .expect("an invalid public-key encoding must exist in range");

    let kr = LsKeyring::boxed();
    // SAFETY: live handle; borrowed mutably for the add, not retained.
    let handle = unsafe { &mut *kr };
    assert_eq!(handle.add("k-bad", &bogus), BAD_ARGUMENT);
    unsafe { free_keyring(kr) };
}

#[test]
fn handles_round_trip_through_verify_and_read_entitlements() {
    let (sk, pk) = common::keypair();
    let token = common::sign(&common::base_claims(), &sk);

    let kr = LsKeyring::boxed();
    // SAFETY: live handle.
    let handle = unsafe { &mut *kr };
    assert_eq!(handle.add(common::KID, &pk), OK);

    let result = ls_ffi_verify(&VerifyInput {
        token: &token,
        keyring: handle,
        now_unix: common::NOW,
        anchor_unix: None,
        fingerprint: None,
    });
    assert_eq!(result.code(), OK, "a valid token verifies");
    assert!(result.has("pro"), "bool entitlement is readable");
    assert_eq!(result.limit("seats"), Some(5), "int entitlement is readable");
    assert!(!result.has("absent"), "absent entitlement resolves false");

    // The result handle also survives a heap round-trip (boxed_result/free_result).
    let boxed = boxed_result(result);
    assert!(!boxed.is_null());
    // SAFETY: boxed is a live result handle, freed exactly once.
    unsafe { free_result(boxed) };
    unsafe { free_keyring(kr) };
}
