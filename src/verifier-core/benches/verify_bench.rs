//! Criterion benchmark for offline verification (perf gate: < 5 ms, SC-005).

use std::collections::BTreeMap;

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use ed25519_dalek::SigningKey;
use verifier_core::{issue, verify, Claims, EntValue, Keyring, VerifyOptions};

fn sample_token() -> (String, Keyring, VerifyOptions) {
    let sk = SigningKey::from_bytes(&[9u8; 32]);
    let mut kr = Keyring::new();
    kr.add("k1", &sk.verifying_key().to_bytes()).unwrap();

    let mut ent = BTreeMap::new();
    ent.insert("export_pdf".to_string(), EntValue::Bool(true));
    ent.insert("max_projects".to_string(), EntValue::Int(10));
    let claims = Claims {
        token_version: 1,
        license_id: "lic".into(),
        product_id: "p".into(),
        plan_id: "pl".into(),
        customer_id: "c".into(),
        issued_at: 1_000,
        expires_at: Some(i64::MAX),
        max_activations: 1,
        fingerprint: None,
        fp_min: None,
        max_skew_secs: None,
        entitlements: ent,
        max_version: None,
        maintenance_until: None,
        key_id: "k1".into(),
        nonce: "n".into(),
    };
    let token = issue(&claims, &sk);
    (token, kr, VerifyOptions::at(1_500))
}

fn bench_verify(c: &mut Criterion) {
    let (token, kr, opts) = sample_token();
    c.bench_function("verify_offline", |b| {
        b.iter(|| {
            verify(black_box(&token), black_box(&kr), black_box(&opts)).unwrap();
        })
    });
}

criterion_group!(benches, bench_verify);
criterion_main!(benches);
