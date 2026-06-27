//! License token format & encoding (ADR-0001).
//!
//! Transport layout (before base64url): `[FORMAT_VERSION:1] ‖ CBOR(payload) ‖ signature:64`.
//! The signed message is domain-separated: `DOMAIN_TAG ‖ [FORMAT_VERSION] ‖ CBOR(payload)`;
//! the envelope prefix and the appended 64 signature bytes are **excluded** from the
//! signed range (TR-002). The string form is `LIC1.<base64url(transport)>`.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use crate::verify::VerifyError;

/// On-the-wire format version (distinct from the in-payload `token_version` claim).
pub const FORMAT_VERSION: u8 = 1;
/// Human-facing prefix on the encoded token.
pub const PREFIX: &str = "LIC1.";
/// Reserved prefix for a future breaking byte-layout (TR-016); rejected as unsupported today.
pub const PREFIX_V2: &str = "LIC2.";
pub(crate) const DOMAIN_TAG: &[u8] = b"LICSRV-LICENSE-TOKEN-v1";
const SIG_LEN: usize = 64;

/// Default maximum encoded-token length in bytes (TR-020); host-overridable via `VerifyOptions`.
pub const MAX_TOKEN_BYTES: usize = 8 * 1024;
/// Default maximum entitlement count (TR-020); host-overridable via `VerifyOptions`.
pub const MAX_ENTITLEMENTS: usize = 256;

/// An entitlement value. The MVP evaluates `Bool` and `Int`; `Other` is a forward-compatible
/// catch-all so string/enum/date value types can be added later without a breaking format
/// change (TR-018). Unknown values deserialize into `Other` and are treated as absent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum EntValue {
    Bool(bool),
    Int(i64),
    Other(ciborium::value::Value),
}

/// The signed license payload. Field names are shortened in CBOR to keep tokens compact.
/// New optional fields are additive within the `LIC1.` envelope (TR-016).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// Per-signal salted hashes bound at activation; checked K-of-N (TR-006).
    #[serde(rename = "fp", skip_serializing_if = "Option::is_none", default)]
    pub fingerprint: Option<Vec<String>>,
    /// Token-raised fingerprint match floor K (raises, never lowers, the caller default) (TR-006).
    #[serde(rename = "fpk", skip_serializing_if = "Option::is_none", default)]
    pub fp_min: Option<u32>,
    /// Token-tightened clock-skew ceiling in seconds (tightens, never loosens) (TR-005).
    #[serde(rename = "sk", skip_serializing_if = "Option::is_none", default)]
    pub max_skew_secs: Option<i64>,
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

/// Strip the `LIC1.` prefix and base64url-decode, enforcing the max token size first
/// (TR-020) so oversized input is rejected fail-fast before any parsing work.
pub(crate) fn decode_transport(token: &str, max_bytes: usize) -> Result<Vec<u8>, VerifyError> {
    if token.len() > max_bytes {
        return Err(VerifyError::Malformed);
    }
    if token.starts_with(PREFIX_V2) {
        return Err(VerifyError::UnsupportedVersion);
    }
    let b64 = token.strip_prefix(PREFIX).ok_or(VerifyError::Malformed)?;
    URL_SAFE_NO_PAD
        .decode(b64.as_bytes())
        .map_err(|_| VerifyError::Malformed)
}

/// Split a decoded transport blob into `(version, payload, signature)`.
/// Never panics: undersized input yields `Malformed`.
pub(crate) fn split_transport(t: &[u8]) -> Result<(u8, &[u8], [u8; SIG_LEN]), VerifyError> {
    if t.len() < 1 + SIG_LEN {
        return Err(VerifyError::Malformed);
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
    let mut out = String::from(PREFIX);
    out.push_str(&URL_SAFE_NO_PAD.encode(transport));
    out
}
