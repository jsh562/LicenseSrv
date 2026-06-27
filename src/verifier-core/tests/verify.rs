//! Integration tests for the offline verifier (covers FR-008, FR-009, FR-011, FR-012, FR-015).

use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use verifier_core::{issue, verify, Claims, EntValue, Keyring, VerifyError, VerifyOptions};

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn keyring_for(sk: &SigningKey, key_id: &str) -> Keyring {
    let mut kr = Keyring::new();
    kr.add(key_id, &sk.verifying_key().to_bytes()).unwrap();
    kr
}

fn base_claims(key_id: &str) -> Claims {
    let mut ent = BTreeMap::new();
    ent.insert("export_pdf".to_string(), EntValue::Bool(true));
    ent.insert("beta".to_string(), EntValue::Bool(false));
    ent.insert("max_projects".to_string(), EntValue::Int(5));
    Claims {
        token_version: 1,
        license_id: "lic-1".into(),
        product_id: "prod-1".into(),
        plan_id: "plan-1".into(),
        customer_id: "cust-1".into(),
        issued_at: 1_000,
        expires_at: Some(2_000),
        max_activations: 3,
        fingerprint: None,
        entitlements: ent,
        max_version: None,
        maintenance_until: None,
        key_id: key_id.into(),
        nonce: "nonce-1".into(),
    }
}

#[test]
fn valid_token_verifies_and_exposes_entitlements() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k1"), &sk);

    let lic = verify(&token, &kr, &VerifyOptions::at(1_500)).expect("should verify");
    assert_eq!(lic.claims.license_id, "lic-1");
    assert!(lic.has("export_pdf"));
    assert!(!lic.has("beta"));
    assert!(lic.has("max_projects")); // Int > 0
    assert_eq!(lic.limit("max_projects"), Some(5));
    assert_eq!(lic.limit("export_pdf"), None);
}

#[test]
fn expired_token_is_rejected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k1"), &sk);
    let err = verify(&token, &kr, &VerifyOptions::at(2_001)).unwrap_err();
    assert_eq!(err, VerifyError::Expired);
}

#[test]
fn perpetual_token_never_expires() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = None;
    let token = issue(&claims, &sk);
    assert!(verify(&token, &kr, &VerifyOptions::at(i64::MAX)).is_ok());
}

#[test]
fn tampered_token_is_rejected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k1"), &sk);

    // Flip one character in the base64 body.
    let mut chars: Vec<char> = token.chars().collect();
    let idx = chars.len() - 5;
    chars[idx] = if chars[idx] == 'A' { 'B' } else { 'A' };
    let tampered: String = chars.into_iter().collect();

    assert!(verify(&tampered, &kr, &VerifyOptions::at(1_500)).is_err());
}

#[test]
fn wrong_signing_key_is_rejected() {
    let real = signing_key(7);
    let attacker = signing_key(9);
    // Keyring trusts the real key under "k1", but the token was signed by the attacker.
    let kr = keyring_for(&real, "k1");
    let token = issue(&base_claims("k1"), &attacker);
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::BadSignature
    );
}

#[test]
fn unknown_key_id_is_rejected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k2"), &sk); // claims reference a key not in the ring
    match verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap_err() {
        VerifyError::UnknownKey(id) => assert_eq!(id, "k2"),
        other => panic!("expected UnknownKey, got {other:?}"),
    }
}

#[test]
fn key_rotation_keyring_verifies_both_generations() {
    let old = signing_key(7);
    let new = signing_key(8);
    let mut kr = Keyring::new();
    kr.add("k-old", &old.verifying_key().to_bytes()).unwrap();
    kr.add("k-new", &new.verifying_key().to_bytes()).unwrap();

    let old_token = issue(&base_claims("k-old"), &old);
    let new_token = issue(&base_claims("k-new"), &new);
    assert!(verify(&old_token, &kr, &VerifyOptions::at(1_500)).is_ok());
    assert!(verify(&new_token, &kr, &VerifyOptions::at(1_500)).is_ok());
}

#[test]
fn clock_rollback_is_detected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = None; // isolate the rollback check from expiry
    let token = issue(&claims, &sk);

    // Anchor saw t=1_000_000; now claims to be well before that, beyond 48h skew.
    let opts = VerifyOptions::at(1_000).with_anchor(1_000_000);
    assert_eq!(
        verify(&token, &kr, &opts).unwrap_err(),
        VerifyError::ClockRolledBack
    );

    // Within skew (anchor minus 1h) is tolerated.
    let ok_opts = VerifyOptions::at(1_000_000 - 3_600).with_anchor(1_000_000);
    assert!(verify(&token, &kr, &ok_opts).is_ok());
}

#[test]
fn fingerprint_binding_is_enforced() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let bound = vec![
        "h-machine".to_string(),
        "h-mac".to_string(),
        "h-cpu".to_string(),
        "h-os".to_string(),
        "h-disk".to_string(),
    ];
    let mut claims = base_claims("k1");
    claims.fingerprint = Some(bound.clone());
    let token = issue(&claims, &sk);

    // Machine-bound token without a local fingerprint → required.
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::FingerprintRequired
    );

    // 3 of 5 agree (disk + os swapped) → still matches (FR-015).
    let drifted = vec![
        "h-machine".to_string(),
        "h-mac".to_string(),
        "h-cpu".to_string(),
        "DIFFERENT-os".to_string(),
        "DIFFERENT-disk".to_string(),
    ];
    assert!(verify(&token, &kr, &VerifyOptions::at(1_500).with_fingerprint(drifted)).is_ok());

    // Only 2 of 5 agree → mismatch.
    let too_different = vec![
        "h-machine".to_string(),
        "h-mac".to_string(),
        "X-cpu".to_string(),
        "X-os".to_string(),
        "X-disk".to_string(),
    ];
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500).with_fingerprint(too_different)).unwrap_err(),
        VerifyError::FingerprintMismatch
    );
}

#[test]
fn malformed_inputs_never_panic() {
    let kr = Keyring::new();
    let opts = VerifyOptions::at(0);
    let samples = [
        "",
        "LIC1.",
        "LIC1.!!!!notbase64!!!!",
        "LIC1.AAAA",
        "not-a-token",
        "LIC2.AAAA",
        "LIC1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ];
    for s in samples {
        // Must return an error, not panic.
        assert!(verify(s, &kr, &opts).is_err());
    }
}
