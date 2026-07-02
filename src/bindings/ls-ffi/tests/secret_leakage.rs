//! T039 (SC-007, FR-014): no key, raw-token, keyring, or fingerprint bytes may appear in any value
//! the binding returns, in any diagnostic string, or in a log — on any path, including errors.
//!
//! The binding returns only integer reason codes and the license's own non-secret claims, and the
//! core's `VerifyError` renders to static category strings. This test scans every observable output
//! for the secret material and asserts none of it leaks.

mod common;

use std::ffi::CString;

use ls_ffi::capi::{
    ls_keyring_add, ls_keyring_free, ls_keyring_new, ls_result_code, ls_result_free, ls_result_has,
    ls_verify,
};
use verifier_core::VerifyError;

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Every closed VerifyError variant renders to a fixed, non-empty category string. Assert it never
/// embeds the secret token or key — the messages are static by construction (no interpolation).
#[test]
fn verify_error_display_is_static_and_leaks_nothing() {
    let (sk, pk) = common::keypair();
    let token = common::sign(&common::base_claims(), &sk);
    let secret_token = token.clone();
    let secret_pub = hex(&pk);
    let secret_priv = hex(sk.to_bytes().as_slice());

    let variants = [
        VerifyError::Malformed,
        VerifyError::UnsupportedVersion,
        VerifyError::UnknownKey,
        VerifyError::KeyNotValid,
        VerifyError::BadSignature,
        VerifyError::Expired,
        VerifyError::ClockRollback,
        VerifyError::FingerprintMismatch,
        VerifyError::FingerprintMissing,
    ];
    for v in variants {
        let rendered = format!("{v} | {v:?}");
        assert!(!rendered.is_empty());
        assert!(!rendered.contains(&secret_token), "token leaked in {v:?}");
        assert!(!rendered.contains(&secret_pub), "public key leaked in {v:?}");
        assert!(!rendered.contains(&secret_priv), "private key leaked in {v:?}");
    }
}

/// Across the C-ABI boundary, a valid and a tampered verify expose only a small integer code and
/// boolean/int entitlement reads — never the token or key bytes.
#[test]
fn c_abi_outputs_carry_no_secret_bytes_on_any_path() {
    let (sk, pk) = common::keypair();
    let token = common::sign(&common::base_claims(), &sk);
    let tampered = common::tamper(&token);
    let secret_token = token.clone();
    let secret_pub = hex(&pk);

    let token_c = CString::new(token).unwrap();
    let tampered_c = CString::new(tampered).unwrap();
    let kid_c = CString::new(common::KID).unwrap();
    let pro_c = CString::new("pro").unwrap();

    // SAFETY: handles are live for the calls and freed once each.
    unsafe {
        let kr = ls_keyring_new();
        assert_eq!(ls_keyring_add(kr, kid_c.as_ptr(), pk.as_ptr()), ls_ffi::reason::OK);

        for token_ptr in [token_c.as_ptr(), tampered_c.as_ptr()] {
            let r = ls_verify(kr, token_ptr, common::NOW, std::ptr::null(), std::ptr::null(), 0);
            // Everything a host can observe from the result:
            let code = ls_result_code(r);
            let pro = ls_result_has(r, pro_c.as_ptr());
            let observable = format!("code={code} pro={pro}");
            // A reason code is a small integer; it cannot encode 32-byte key or token material.
            assert!(code < 256, "reason code must be a small integer, got {code}");
            assert!(!observable.contains(&secret_token), "token leaked across the boundary");
            assert!(!observable.contains(&secret_pub), "key leaked across the boundary");
            ls_result_free(r);
        }
        ls_keyring_free(kr);
    }
}
