//! The offline verification pipeline: decode → signature check → anchor → expiry →
//! fingerprint. Verification performs **no network I/O** and is panic-free on arbitrary
//! input (fuzzed). Order matters: nothing in the payload is trusted until the signature
//! verifies, except `key_id`, which only selects which trusted public key to check against.

use ed25519_dalek::{Signature, VerifyingKey};

use crate::anchor::DEFAULT_SKEW_SECS;
use crate::fingerprint::{fingerprint_matches, DEFAULT_FP_THRESHOLD};
use crate::keyring::Keyring;
use crate::token::{self, Claims, EntValue, FORMAT_VERSION};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VerifyError {
    #[error("bad token format")]
    BadFormat,
    #[error("unsupported format version: {0}")]
    UnsupportedVersion(u8),
    #[error("base64 decode failed")]
    Base64,
    #[error("cbor decode failed")]
    Cbor,
    #[error("invalid public key")]
    BadKey,
    #[error("unknown key id: {0}")]
    UnknownKey(String),
    #[error("signature verification failed")]
    BadSignature,
    #[error("license expired")]
    Expired,
    #[error("clock rolled back")]
    ClockRolledBack,
    #[error("fingerprint required but not provided")]
    FingerprintRequired,
    #[error("fingerprint mismatch")]
    FingerprintMismatch,
}

/// Inputs that the host supplies at verification time. Build with [`VerifyOptions::at`].
#[derive(Clone, Debug)]
pub struct VerifyOptions {
    /// Current unix time (seconds) as the host sees it.
    pub now_unix: i64,
    /// Highest timestamp ever observed (persisted by the host); enables rollback detection.
    pub anchor_unix: Option<i64>,
    /// Tolerated backward skew in seconds.
    pub skew_secs: i64,
    /// This machine's fingerprint signals, required when the license is machine-bound.
    pub local_fingerprint: Option<Vec<String>>,
    /// K in the K-of-N fingerprint match.
    pub fp_threshold: usize,
}

impl VerifyOptions {
    pub fn at(now_unix: i64) -> Self {
        Self {
            now_unix,
            anchor_unix: None,
            skew_secs: DEFAULT_SKEW_SECS,
            local_fingerprint: None,
            fp_threshold: DEFAULT_FP_THRESHOLD,
        }
    }

    pub fn with_anchor(mut self, anchor_unix: i64) -> Self {
        self.anchor_unix = Some(anchor_unix);
        self
    }

    pub fn with_fingerprint(mut self, signals: Vec<String>) -> Self {
        self.local_fingerprint = Some(signals);
        self
    }
}

/// A license whose signature and time/binding constraints have all passed.
#[derive(Debug, Clone)]
pub struct VerifiedLicense {
    pub claims: Claims,
}

impl VerifiedLicense {
    /// True when the entitlement is present and enabled (boolean true, or integer > 0).
    pub fn has(&self, key: &str) -> bool {
        match self.claims.entitlements.get(key) {
            Some(EntValue::Bool(b)) => *b,
            Some(EntValue::Int(n)) => *n > 0,
            None => false,
        }
    }

    /// The integer limit for an entitlement, if it is an integer entitlement.
    pub fn limit(&self, key: &str) -> Option<i64> {
        match self.claims.entitlements.get(key) {
            Some(EntValue::Int(n)) => Some(*n),
            _ => None,
        }
    }
}

/// Verify a `LIC1.` token fully offline. Returns the validated license or the first
/// failing check.
pub fn verify(
    token: &str,
    keyring: &Keyring,
    opts: &VerifyOptions,
) -> Result<VerifiedLicense, VerifyError> {
    let transport = token::decode_transport(token)?;
    let (version, payload, sig_bytes) = token::split_transport(&transport)?;
    if version != FORMAT_VERSION {
        return Err(VerifyError::UnsupportedVersion(version));
    }

    let claims: Claims = ciborium::from_reader(payload).map_err(|_| VerifyError::Cbor)?;

    let vk: &VerifyingKey = keyring
        .get(&claims.key_id)
        .ok_or_else(|| VerifyError::UnknownKey(claims.key_id.clone()))?;

    let signing_input = token::signing_input(version, payload);
    let signature = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(&signing_input, &signature)
        .map_err(|_| VerifyError::BadSignature)?;

    // Signature is valid; the payload can now be trusted.
    if let Some(anchor) = opts.anchor_unix {
        if opts.now_unix < anchor - opts.skew_secs {
            return Err(VerifyError::ClockRolledBack);
        }
    }
    if let Some(exp) = claims.expires_at {
        if opts.now_unix > exp {
            return Err(VerifyError::Expired);
        }
    }
    if let Some(bound) = &claims.fingerprint {
        match &opts.local_fingerprint {
            None => return Err(VerifyError::FingerprintRequired),
            Some(local) => {
                if !fingerprint_matches(bound, local, opts.fp_threshold) {
                    return Err(VerifyError::FingerprintMismatch);
                }
            }
        }
    }

    Ok(VerifiedLicense { claims })
}
