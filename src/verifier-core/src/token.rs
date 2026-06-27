//! License token format & encoding (ADR-0001).
//!
//! Transport layout (before base64url): `[FORMAT_VERSION:1] ‖ CBOR(payload) ‖ signature:64`.
//! The signed message is domain-separated: `DOMAIN_TAG ‖ [FORMAT_VERSION] ‖ CBOR(payload)`,
//! which prevents a signature from one context being replayed in another.
//! The string form is `LIC1.<base64url(transport)>`.

use std::collections::BTreeMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use crate::verify::VerifyError;

/// On-the-wire format version (distinct from the in-payload `token_version` claim).
pub const FORMAT_VERSION: u8 = 1;
/// Human-facing prefix on the encoded token.
pub const PREFIX: &str = "LIC1.";
pub(crate) const DOMAIN_TAG: &[u8] = b"LICSRV-LICENSE-TOKEN-v1";
const SIG_LEN: usize = 64;

/// An entitlement value: a boolean feature flag or an integer limit.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum EntValue {
    Bool(bool),
    Int(i64),
}

/// The signed license payload. Field names are shortened in CBOR to keep tokens compact.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Claims {
    #[serde(rename = "v")]
    pub token_version: u16,
    #[serde(rename = "lid")]
    pub license_id: String,
    #[serde(rename = "pid")]
    pub product_id: String,
    #[serde(rename = "pl")]
    pub plan_id: String,
    #[serde(rename = "cid")]
    pub customer_id: String,
    #[serde(rename = "iat")]
    pub issued_at: i64,
    #[serde(rename = "exp", skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<i64>,
    #[serde(rename = "maxa")]
    pub max_activations: u32,
    /// Per-signal hashes (e.g. 5 of them) bound at activation; checked K-of-N (FR-015).
    #[serde(rename = "fp", skip_serializing_if = "Option::is_none", default)]
    pub fingerprint: Option<Vec<String>>,
    #[serde(rename = "ent", default)]
    pub entitlements: BTreeMap<String, EntValue>,
    #[serde(rename = "maxv", skip_serializing_if = "Option::is_none", default)]
    pub max_version: Option<String>,
    #[serde(rename = "mnt", skip_serializing_if = "Option::is_none", default)]
    pub maintenance_until: Option<i64>,
    #[serde(rename = "kid")]
    pub key_id: String,
    #[serde(rename = "non")]
    pub nonce: String,
}

pub(crate) fn signing_input(version: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(DOMAIN_TAG.len() + 1 + payload.len());
    v.extend_from_slice(DOMAIN_TAG);
    v.push(version);
    v.extend_from_slice(payload);
    v
}

pub(crate) fn decode_transport(token: &str) -> Result<Vec<u8>, VerifyError> {
    let b64 = token.strip_prefix(PREFIX).ok_or(VerifyError::BadFormat)?;
    URL_SAFE_NO_PAD
        .decode(b64.as_bytes())
        .map_err(|_| VerifyError::Base64)
}

/// Split a decoded transport blob into `(version, payload, signature)`.
/// Never panics: undersized input yields `BadFormat`.
pub(crate) fn split_transport(t: &[u8]) -> Result<(u8, &[u8], [u8; SIG_LEN]), VerifyError> {
    if t.len() < 1 + SIG_LEN {
        return Err(VerifyError::BadFormat);
    }
    let version = t[0];
    let sig_start = t.len() - SIG_LEN;
    let payload = &t[1..sig_start];
    let mut sig = [0u8; SIG_LEN];
    sig.copy_from_slice(&t[sig_start..]);
    Ok((version, payload, sig))
}

/// Sign `claims` into a `LIC1.` token. Used by the air-gap portal and tests; the
/// server signs via KMS (ADR-0003) and does not use this path in production.
pub fn issue(claims: &Claims, signing_key: &SigningKey) -> String {
    let mut payload = Vec::new();
    ciborium::into_writer(claims, &mut payload).expect("CBOR serialization is infallible for Claims");
    let signature = signing_key.sign(&signing_input(FORMAT_VERSION, &payload));
    let mut transport = Vec::with_capacity(1 + payload.len() + SIG_LEN);
    transport.push(FORMAT_VERSION);
    transport.extend_from_slice(&payload);
    transport.extend_from_slice(&signature.to_bytes());
    format!("{}{}", PREFIX, URL_SAFE_NO_PAD.encode(transport))
}
