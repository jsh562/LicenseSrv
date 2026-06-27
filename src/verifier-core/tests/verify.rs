//! Integration tests for the offline verifier — covers TR-001…TR-020.

use std::collections::BTreeMap;

use ciborium::value::Value;
use ed25519_dalek::SigningKey;
use verifier_core::{
    issue, verify, Claims, EntValue, KeyEntry, Keyring, VerifyError, VerifyOptions,
};

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
        fp_min: None,
        max_skew_secs: None,
        entitlements: ent,
        max_version: None,
        maintenance_until: None,
        key_id: key_id.into(),
        nonce: "nonce-1".into(),
    }
}

fn bound_fp() -> Vec<String> {
    vec![
        "h-machine".into(),
        "h-cpu".into(),
        "h-disk".into(),
        "h-mac".into(),
        "h-os".into(),
    ]
}

// TR-001/TR-002/TR-007 — valid token verifies and exposes entitlements + anchor.
#[test]
fn valid_token_verifies_and_exposes_entitlements() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k1"), &sk);

    let lic = verify(&token, &kr, &VerifyOptions::at(1_500)).expect("should verify");
    assert_eq!(lic.claims.license_id, "lic-1");
    assert!(lic.has("export_pdf"));
    assert!(!lic.has("beta"));
    assert!(lic.has("max_projects")); // Int > 0 is truthy
    assert_eq!(lic.limit("max_projects"), Some(5));
    assert_eq!(lic.limit("export_pdf"), None);
    assert_eq!(lic.limit("absent"), None);
    assert!(!lic.has("absent"));
    assert_eq!(lic.next_anchor, 1_500); // max(stored=now, now)
}

// TR-004 — expiry and perpetual.
#[test]
fn expired_token_is_rejected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k1"), &sk);
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(2_001)).unwrap_err(),
        VerifyError::Expired
    );
}

#[test]
fn perpetual_token_never_expires() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = None;
    let token = issue(&claims, &sk);
    assert!(verify(&token, &kr, &VerifyOptions::at(5_000_000)).is_ok());
}

// TR-001/TR-003 — tampered, wrong key, unknown key.
#[test]
fn tampered_token_is_rejected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let token = issue(&base_claims("k1"), &sk);
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
    let token = issue(&base_claims("k2"), &sk);
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::UnknownKey
    );
}

// TR-008 — keyring rotation.
#[test]
fn key_rotation_keyring_verifies_both_generations() {
    let old = signing_key(7);
    let new = signing_key(8);
    let mut kr = Keyring::new();
    kr.add("k-old", &old.verifying_key().to_bytes()).unwrap();
    kr.add("k-new", &new.verifying_key().to_bytes()).unwrap();
    assert!(verify(&issue(&base_claims("k-old"), &old), &kr, &VerifyOptions::at(1_500)).is_ok());
    assert!(verify(&issue(&base_claims("k-new"), &new), &kr, &VerifyOptions::at(1_500)).is_ok());
}

// TR-017 — keyring per-key validity window + revoked → KeyNotValid.
#[test]
fn key_validity_window_and_revoked_are_enforced() {
    let sk = signing_key(7);
    let vk = sk.verifying_key();

    // Window [1000, 2000): valid at 1500, invalid at 2000 (exclusive) and before 1000.
    let mut kr = Keyring::new();
    kr.add_entry(
        "k1",
        KeyEntry {
            key: vk,
            valid_from: Some(1_000),
            valid_until: Some(2_000),
            revoked: false,
        },
    );
    let mut claims = base_claims("k1");
    claims.expires_at = None;
    let token = issue(&claims, &sk);
    assert!(verify(&token, &kr, &VerifyOptions::at(1_500)).is_ok());
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(2_000)).unwrap_err(),
        VerifyError::KeyNotValid
    );
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(500)).unwrap_err(),
        VerifyError::KeyNotValid
    );

    // Revoked key → KeyNotValid regardless of time.
    let mut kr2 = Keyring::new();
    kr2.add_entry(
        "k1",
        KeyEntry {
            key: vk,
            valid_from: None,
            valid_until: None,
            revoked: true,
        },
    );
    assert_eq!(
        verify(&token, &kr2, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::KeyNotValid
    );
}

// TR-005 — clock rollback, anchor return, future-dated guard, token-tightened skew.
#[test]
fn clock_rollback_and_anchor_return() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = None;
    let token = issue(&claims, &sk);

    // now far before anchor (beyond 48h skew) → rollback.
    let opts = VerifyOptions::at(1_000).with_anchor(1_000_000);
    assert_eq!(
        verify(&token, &kr, &opts).unwrap_err(),
        VerifyError::ClockRollback
    );

    // within skew → ok, and the returned anchor is max(stored, now).
    let ok = VerifyOptions::at(1_000_000 - 3_600).with_anchor(1_000_000);
    let lic = verify(&token, &kr, &ok).unwrap();
    assert_eq!(lic.next_anchor, 1_000_000);

    // advancing now past the anchor advances the persisted anchor.
    let adv = VerifyOptions::at(2_000_000).with_anchor(1_000_000);
    assert_eq!(verify(&token, &kr, &adv).unwrap().next_anchor, 2_000_000);
}

#[test]
fn future_dated_token_does_not_poison_anchor() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = None;
    claims.issued_at = 10_000_000; // far in the future relative to `now`
    let token = issue(&claims, &sk);
    // now = 1000, issued_at way beyond now + skew → rejected (anchor cannot be poisoned).
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_000)).unwrap_err(),
        VerifyError::ClockRollback
    );
}

#[test]
fn token_may_tighten_skew() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = None;
    claims.max_skew_secs = Some(60); // tighten to 60s
    let token = issue(&claims, &sk);
    // now is 120s before anchor: tolerated under default 48h, but rejected under tightened 60s.
    let opts = VerifyOptions::at(1_000_000 - 120).with_anchor(1_000_000);
    assert_eq!(
        verify(&token, &kr, &opts).unwrap_err(),
        VerifyError::ClockRollback
    );
}

// TR-006/TR-013 — fingerprint binding, K-of-5 drift, missing, token-raised K.
#[test]
fn fingerprint_binding_is_enforced() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.fingerprint = Some(bound_fp());
    let token = issue(&claims, &sk);

    // machine-bound but no local fingerprint → refused.
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::FingerprintMissing
    );

    // 3 of 5 agree → ok (default K=3).
    let drifted = vec![
        "h-machine".into(),
        "h-cpu".into(),
        "h-disk".into(),
        "X-mac".into(),
        "X-os".into(),
    ];
    assert!(verify(&token, &kr, &VerifyOptions::at(1_500).with_fingerprint(drifted)).is_ok());

    // only 2 of 5 → mismatch.
    let too_diff = vec![
        "h-machine".into(),
        "h-cpu".into(),
        "X-disk".into(),
        "X-mac".into(),
        "X-os".into(),
    ];
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500).with_fingerprint(too_diff)).unwrap_err(),
        VerifyError::FingerprintMismatch
    );
}

#[test]
fn token_may_raise_fingerprint_k() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.fingerprint = Some(bound_fp());
    claims.fp_min = Some(5); // require all 5
    let token = issue(&claims, &sk);

    // 4 of 5 agree — would pass default K=3, but token raised K to 5 → mismatch.
    let four = vec![
        "h-machine".into(),
        "h-cpu".into(),
        "h-disk".into(),
        "h-mac".into(),
        "X-os".into(),
    ];
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500).with_fingerprint(four)).unwrap_err(),
        VerifyError::FingerprintMismatch
    );
    assert!(verify(&token, &kr, &VerifyOptions::at(1_500).with_fingerprint(bound_fp())).is_ok());
}

// TR-018 — unknown entitlement value type is ignored (treated as absent).
#[test]
fn unknown_entitlement_type_is_ignored() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims
        .entitlements
        .insert("tier".into(), EntValue::Other(Value::Text("gold".into())));
    let token = issue(&claims, &sk);
    let lic = verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap();
    // unknown-typed entitlement resolves as absent.
    assert!(!lic.has("tier"));
    assert_eq!(lic.limit("tier"), None);
}

// TR-020 — size bounds: oversized token and too many entitlements → Malformed.
#[test]
fn oversized_inputs_are_rejected() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");

    let big = format!("LIC1.{}", "A".repeat(9_000));
    assert_eq!(
        verify(&big, &kr, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::Malformed
    );

    let mut claims = base_claims("k1");
    claims.expires_at = None;
    for i in 0..300 {
        claims
            .entitlements
            .insert(format!("f{i}"), EntValue::Bool(true));
    }
    let token = issue(&claims, &sk);
    assert_eq!(
        verify(&token, &kr, &VerifyOptions::at(1_500)).unwrap_err(),
        VerifyError::Malformed
    );
}

// Edge — unsupported version envelope (LIC2.) is distinct from malformed.
#[test]
fn unsupported_version_envelope_is_rejected() {
    let kr = Keyring::new();
    assert_eq!(
        verify("LIC2.AAAA", &kr, &VerifyOptions::at(0)).unwrap_err(),
        VerifyError::UnsupportedVersion
    );
}

// TR-010 — arbitrary input never panics.
#[test]
fn malformed_inputs_never_panic() {
    let kr = Keyring::new();
    let opts = VerifyOptions::at(0);
    for s in [
        "",
        "LIC1.",
        "LIC1.!!!!",
        "LIC1.AAAA",
        "not-a-token",
        "LIC1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        assert!(verify(s, &kr, &opts).is_err());
    }
}

// TR-011/TR-019 — coarse performance regression gate: a single offline verify is far
// under the 5 ms p99 budget on the native baseline.
#[test]
fn verify_latency_under_budget() {
    let sk = signing_key(7);
    let kr = keyring_for(&sk, "k1");
    let mut claims = base_claims("k1");
    claims.expires_at = Some(i64::MAX);
    let token = issue(&claims, &sk);
    let opts = VerifyOptions::at(1_500);
    for _ in 0..5 {
        verify(&token, &kr, &opts).unwrap(); // warm up + correctness
    }

    // Debug builds are unoptimized; the authoritative p99 budget is enforced by the
    // release criterion bench (TR-019). Only assert the budget in optimized builds.
    if cfg!(debug_assertions) {
        return;
    }

    let start = std::time::Instant::now();
    let iters = 1_000u32;
    for _ in 0..iters {
        verify(&token, &kr, &opts).unwrap();
    }
    let per = start.elapsed() / iters;
    assert!(
        per < std::time::Duration::from_millis(5),
        "verify exceeded the 5 ms budget: {per:?}"
    );
}
