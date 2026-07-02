//! T029 (US4, SC-008, FR-019): verification is deterministic. With a fixed set of inputs (token,
//! keyring, now, anchor, fingerprint) the outcome — reason code, entitlements, and next anchor —
//! is identical on every call, with no dependence on wall-clock time (now is always the supplied
//! input). This is what lets the parity and integration tests assert a stable oracle.

mod common;

use std::ffi::CString;

use ls_ffi::capi::{
    ls_keyring_add, ls_keyring_free, ls_keyring_new, ls_result_code, ls_result_free, ls_result_has,
    ls_result_limit, ls_result_next_anchor, ls_verify,
};

#[derive(PartialEq, Debug)]
struct Outcome {
    code: u32,
    pro: bool,
    seats: Option<i64>,
    anchor: Option<i64>,
}

/// One full verify through the C ABI at host time `now`, snapshotting everything observable.
unsafe fn snapshot(kr: *const ls_ffi::LsKeyring, token: &CString, now: i64) -> Outcome {
    let pro = CString::new("pro").unwrap();
    let seats = CString::new("seats").unwrap();

    let r = ls_verify(kr, token.as_ptr(), now, std::ptr::null(), std::ptr::null(), 0);
    let code = ls_result_code(r);
    let pro_on = ls_result_has(r, pro.as_ptr());
    let mut seats_v = 0i64;
    let seats = if ls_result_limit(r, seats.as_ptr(), &mut seats_v) {
        Some(seats_v)
    } else {
        None
    };
    let mut anchor_v = 0i64;
    let anchor = if ls_result_next_anchor(r, &mut anchor_v) {
        Some(anchor_v)
    } else {
        None
    };
    ls_result_free(r);
    Outcome {
        code,
        pro: pro_on,
        seats,
        anchor,
    }
}

#[test]
fn valid_verify_is_deterministic_over_many_calls() {
    let (sk, pk) = common::keypair();
    let token = CString::new(common::sign(&common::base_claims(), &sk)).unwrap();
    let kid = CString::new(common::KID).unwrap();

    // SAFETY: kr is live until freed at the end.
    unsafe {
        let kr = ls_keyring_new();
        assert_eq!(ls_keyring_add(kr, kid.as_ptr(), pk.as_ptr()), ls_ffi::reason::OK);

        let first = snapshot(kr, &token, common::NOW);
        assert_eq!(first.code, ls_ffi::reason::OK);
        assert!(first.pro);
        assert_eq!(first.seats, Some(5));

        for _ in 0..1_000 {
            assert_eq!(snapshot(kr, &token, common::NOW), first, "verify must be deterministic");
        }
        ls_keyring_free(kr);
    }
}

#[test]
fn expired_verify_is_deterministic() {
    let (sk, pk) = common::keypair();
    let token = CString::new(common::sign(&common::base_claims(), &sk)).unwrap();
    let kid = CString::new(common::KID).unwrap();
    let expired_now = 1_950_000_000; // past expires_at

    // SAFETY: kr is live until freed.
    unsafe {
        let kr = ls_keyring_new();
        assert_eq!(ls_keyring_add(kr, kid.as_ptr(), pk.as_ptr()), ls_ffi::reason::OK);

        let first = snapshot(kr, &token, expired_now);
        assert_eq!(first.code, 6, "Expired");
        for _ in 0..1_000 {
            assert_eq!(snapshot(kr, &token, expired_now), first);
        }
        ls_keyring_free(kr);
    }
}
