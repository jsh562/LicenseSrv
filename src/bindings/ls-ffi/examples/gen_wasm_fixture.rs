//! Generate the deterministic test fixture the WASM Node sample/test consume (so signing stays in
//! the Rust core — no cryptography is reimplemented in JS). Uses a fixed seed key for
//! reproducibility. Run: `cargo run -p ls-ffi --example gen_wasm_fixture > ../wasm/tests/fixture.json`.

use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use verifier_core::{issue, Claims, EntValue};

const KID: &str = "k-test-1";
const NOW: i64 = 1_800_000_000;
const EXPIRED_NOW: i64 = 1_950_000_000; // past expires_at below

fn base_claims() -> Claims {
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

/// Flip one base64url char in the signature tail to forge a BadSignature tamper.
fn tamper(token: &str) -> String {
    let mut bytes: Vec<u8> = token.bytes().collect();
    let idx = bytes.len() - 6;
    bytes[idx] = if bytes[idx] == b'A' { b'B' } else { b'A' };
    String::from_utf8(bytes).unwrap()
}

fn main() {
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let pk = sk.verifying_key().to_bytes();
    let token = issue(&base_claims(), &sk);
    let tampered = tamper(&token);

    let pk_json: Vec<String> = pk.iter().map(|b| b.to_string()).collect();

    // Hand-rolled JSON (no serde_json dependency needed for this tiny shape).
    println!("{{");
    println!("  \"keyId\": \"{KID}\",");
    println!("  \"publicKey\": [{}],", pk_json.join(", "));
    println!("  \"nowUnix\": {NOW},");
    println!("  \"expiredNow\": {EXPIRED_NOW},");
    println!("  \"token\": \"{token}\",");
    println!("  \"tampered\": \"{tampered}\"");
    println!("}}");
}
