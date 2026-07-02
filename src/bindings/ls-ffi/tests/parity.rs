//! T028 (US4, SC-003, FR-006): cross-binding parity. The *same* valid and tampered tokens are run
//! through the in-process C ABI and through the WASM binding (in Node), and the reason codes MUST
//! match — identical failure everywhere is the core promise of one shared reason map.
//!
//! Requires `node` and the built WASM package (`../wasm/pkg`). Both are present locally and in the
//! `parity` CI job; the test fails loudly if either is missing rather than silently passing.

mod common;

use std::ffi::CString;
use std::path::PathBuf;
use std::process::Command;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn hex32(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// C-ABI reason code for `token` against a keyring trusting `pk` under `KID`, at `NOW`.
fn c_abi_code(token: &str, pk: &[u8; 32]) -> u32 {
    use ls_ffi::capi::{ls_keyring_add, ls_keyring_free, ls_keyring_new, ls_result_code, ls_result_free, ls_verify};
    let token_c = CString::new(token).unwrap();
    let kid_c = CString::new(common::KID).unwrap();
    // SAFETY: handles are live for the call and freed exactly once.
    unsafe {
        let kr = ls_keyring_new();
        assert_eq!(ls_keyring_add(kr, kid_c.as_ptr(), pk.as_ptr()), ls_ffi::reason::OK);
        let r = ls_verify(kr, token_c.as_ptr(), common::NOW, std::ptr::null(), std::ptr::null(), 0);
        let code = ls_result_code(r);
        ls_result_free(r);
        ls_keyring_free(kr);
        code
    }
}

/// WASM reason codes (valid, tampered) via the Node helper over the built package.
fn wasm_codes(token: &str, tampered: &str, pk: &[u8; 32]) -> (u32, u32) {
    let helper = crate_dir().join("../wasm/tests/parity-helper.mjs");
    let pkg = crate_dir().join("../wasm/pkg/licensesrv.js");
    assert!(pkg.exists(), "WASM package missing ({}); run wasm-pack first", pkg.display());

    let out = Command::new("node")
        .arg(&helper)
        .arg(common::KID)
        .arg(hex32(pk))
        .arg(common::NOW.to_string())
        .arg(token)
        .arg(tampered)
        .output()
        .expect("failed to run node for the WASM parity side (is node installed?)");
    assert!(out.status.success(), "node helper failed: {}", String::from_utf8_lossy(&out.stderr));

    let stdout = String::from_utf8_lossy(&out.stdout);
    // Parse "valid=<n> tampered=<m>".
    let mut valid = None;
    let mut tampered_code = None;
    for tok in stdout.split_whitespace() {
        if let Some(v) = tok.strip_prefix("valid=") {
            valid = v.parse().ok();
        } else if let Some(v) = tok.strip_prefix("tampered=") {
            tampered_code = v.parse().ok();
        }
    }
    (
        valid.unwrap_or_else(|| panic!("no valid= in node output: {stdout}")),
        tampered_code.unwrap_or_else(|| panic!("no tampered= in node output: {stdout}")),
    )
}

#[test]
fn c_abi_and_wasm_agree_on_valid_and_tampered() {
    let (sk, pk) = common::keypair();
    let token = common::sign(&common::base_claims(), &sk);
    let tampered = common::tamper(&token);

    let c_valid = c_abi_code(&token, &pk);
    let c_tampered = c_abi_code(&tampered, &pk);
    let (w_valid, w_tampered) = wasm_codes(&token, &tampered, &pk);

    assert_eq!(c_valid, w_valid, "valid token: C-ABI and WASM reason codes must match");
    assert_eq!(c_tampered, w_tampered, "tampered token: C-ABI and WASM reason codes must match");
    // And they are the expected categories: OK vs BadSignature.
    assert_eq!(c_valid, ls_ffi::reason::OK);
    assert_eq!(c_tampered, 5, "tampered → BadSignature in both bindings");
}
