//! Shared test helpers: mint real `LIC1` tokens with the core's `issue` path so the binding
//! tests verify genuine signed tokens (not fixtures). Reused by the handle, parity, determinism,
//! version, and secret-leakage suites.
#![allow(dead_code)]

use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use verifier_core::{issue, Claims, EntValue};

pub const KID: &str = "k-test-1";
/// A fixed "now" that sits between `issued_at` and `expires_at` in [`base_claims`].
pub const NOW: i64 = 1_800_000_000;

/// Generate an ephemeral Ed25519 keypair; returns the signing key and the 32-byte public key.
pub fn keypair() -> (SigningKey, [u8; 32]) {
    let sk = SigningKey::generate(&mut OsRng);
    let pk = sk.verifying_key().to_bytes();
    (sk, pk)
}

/// A valid, non-expiring-soon, non-machine-bound license with two entitlements:
/// `pro` (bool true) and `seats` (int 5).
pub fn base_claims() -> Claims {
    let mut entitlements = BTreeMap::new();
    entitlements.insert("pro".to_string(), EntValue::Bool(true));
    entitlements.insert("seats".to_string(), EntValue::Int(5));
    Claims {
        token_version: 1,
        license_id: "lic-1".to_string(),
        product_id: "prod-1".to_string(),
        plan_id: "plan-1".to_string(),
        customer_id: "cust-1".to_string(),
        issued_at: 1_700_000_000,
        expires_at: Some(1_900_000_000),
        max_activations: 3,
        fingerprint: None,
        fp_min: None,
        max_skew_secs: None,
        entitlements,
        max_version: None,
        maintenance_until: None,
        key_id: KID.to_string(),
        nonce: "nonce-1".to_string(),
    }
}

/// Sign `claims` into a `LIC1.` token string with `sk`.
pub fn sign(claims: &Claims, sk: &SigningKey) -> String {
    issue(claims, sk)
}

/// Flip one character deep in the base64url body to forge a tamper that fails the signature
/// check (not the structural parse) — i.e. a `BadSignature`, the canonical "tampered" case.
pub fn tamper(token: &str) -> String {
    let mut bytes: Vec<u8> = token.bytes().collect();
    // The prefix is "LIC1."; mutate a byte well past it, inside the signed/encoded region.
    let idx = bytes.len() - 6;
    bytes[idx] = if bytes[idx] == b'A' { b'B' } else { b'A' };
    String::from_utf8(bytes).expect("ascii base64url stays valid utf8")
}
