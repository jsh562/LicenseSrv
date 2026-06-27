//! The offline verification pipeline: decode → size bounds → key selection + validity →
//! signature check → time/anchor → fingerprint → entitlements. Verification performs
//! **no network I/O** and is panic-free on arbitrary input (fuzzed). Order matters: nothing
//! in the payload is trusted until the signature verifies, except `key_id`, which only
//! selects which trusted public key to check against.

use core::fmt;

use ed25519_dalek::{Signature, VerifyingKey};

use alloc::string::String;
use alloc::vec::Vec;

use crate::anchor::{next_anchor, DEFAULT_SKEW_SECS};
use crate::entitlement::{resolve_bool, resolve_int};
use crate::fingerprint::{fingerprint_matches, DEFAULT_FP_THRESHOLD};
use crate::keyring::Keyring;
use crate::token::{self, Claims, FORMAT_VERSION, MAX_ENTITLEMENTS, MAX_TOKEN_BYTES};

/// The closed, append-only set of verification failure reasons (TR-015). Variants carry
/// **no** secret or diagnostic detail. New reasons are appended (hence `#[non_exhaustive]`);
/// existing variants are never reordered or removed — bindings map them by stable identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum VerifyError {
    Malformed,
    UnsupportedVersion,
    UnknownKey,
    KeyNotValid,
    BadSignature,
    Expired,
    ClockRollback,
    FingerprintMismatch,
    FingerprintMissing,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            VerifyError::Malformed => "malformed token",
            VerifyError::UnsupportedVersion => "unsupported token version",
            VerifyError::UnknownKey => "unknown key id",
            VerifyError::KeyNotValid => "signing key not valid",
            VerifyError::BadSignature => "signature verification failed",
            VerifyError::Expired => "license expired",
            VerifyError::ClockRollback => "clock rolled back",
            VerifyError::FingerprintMismatch => "machine fingerprint mismatch",
            VerifyError::FingerprintMissing => "machine fingerprint required but not provided",
        };
        f.write_str(s)
    }
}

impl core::error::Error for VerifyError {}

/// Inputs that the host supplies at verification time. Build with [`VerifyOptions::at`].
#[derive(Clone, Debug)]
pub struct VerifyOptions {
    /// Current unix time (seconds) as the host sees it.
    pub now_unix: i64,
    /// Highest timestamp ever observed (persisted by the host); enables rollback detection.
    pub anchor_unix: Option<i64>,
    /// Tolerated backward skew in seconds (caller default; a token may tighten it).
    pub skew_secs: i64,
    /// This machine's fingerprint signals, required when the license is machine-bound.
    pub local_fingerprint: Option<Vec<String>>,
    /// Caller's K in the K-of-N fingerprint match (a token may raise it).
    pub fp_threshold: usize,
    /// Maximum accepted encoded-token length in bytes (TR-020).
    pub max_token_bytes: usize,
    /// Maximum accepted entitlement count (TR-020).
    pub max_entitlements: usize,
}

impl VerifyOptions {
    pub fn at(now_unix: i64) -> Self {
        Self {
            now_unix,
            anchor_unix: None,
            skew_secs: DEFAULT_SKEW_SECS,
            local_fingerprint: None,
            fp_threshold: DEFAULT_FP_THRESHOLD,
            max_token_bytes: MAX_TOKEN_BYTES,
            max_entitlements: MAX_ENTITLEMENTS,
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
    /// The anchor value the host SHOULD persist after this verify: `max(prior_anchor, now)`.
    /// A future-dated `issued_at` cannot advance it (TR-005).
    pub next_anchor: i64,
}

impl VerifiedLicense {
    /// True when the entitlement is present and enabled (boolean true, or integer > 0).
    /// Absent or unknown-typed entitlements resolve to false (TR-007/TR-018).
    pub fn has(&self, key: &str) -> bool {
        resolve_bool(&self.claims.entitlements, key)
    }

    /// The integer limit for an entitlement, or `None` when absent / not an integer (TR-007).
    pub fn limit(&self, key: &str) -> Option<i64> {
        resolve_int(&self.claims.entitlements, key)
    }
}

/// Verify a `LIC1.` token fully offline. Returns the validated license or the first
/// failing check.
pub fn verify(
    token: &str,
    keyring: &Keyring,
    opts: &VerifyOptions,
) -> Result<VerifiedLicense, VerifyError> {
    let transport = token::decode_transport(token, opts.max_token_bytes)?;
    let (version, payload, sig_bytes) = token::split_transport(&transport)?;
    if version != FORMAT_VERSION {
        return Err(VerifyError::UnsupportedVersion);
    }

    let claims: Claims = ciborium::from_reader(payload).map_err(|_| VerifyError::Malformed)?;

    if claims.entitlements.len() > opts.max_entitlements {
        return Err(VerifyError::Malformed);
    }

    // Select the trusted key and enforce its offline validity window before the signature.
    let entry = keyring.get(&claims.key_id).ok_or(VerifyError::UnknownKey)?;
    if entry.revoked {
        return Err(VerifyError::KeyNotValid);
    }
    if let Some(valid_from) = entry.valid_from {
        if opts.now_unix < valid_from {
            return Err(VerifyError::KeyNotValid);
        }
    }
    if let Some(valid_until) = entry.valid_until {
        if opts.now_unix >= valid_until {
            return Err(VerifyError::KeyNotValid);
        }
    }
    let vk: &VerifyingKey = &entry.key;

    let signing_input = token::signing_input(version, payload);
    let signature = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(&signing_input, &signature)
        .map_err(|_| VerifyError::BadSignature)?;

    // Signature valid → the payload can now be trusted.
    let effective_skew = match claims.max_skew_secs {
        Some(token_skew) => core::cmp::min(opts.skew_secs, token_skew),
        None => opts.skew_secs,
    };

    // Future-dated token guard (anchor-poisoning protection, TR-005).
    if claims.issued_at > opts.now_unix.saturating_add(effective_skew) {
        return Err(VerifyError::ClockRollback);
    }
    if let Some(anchor) = opts.anchor_unix {
        if opts.now_unix < anchor.saturating_sub(effective_skew) {
            return Err(VerifyError::ClockRollback);
        }
    }
    if let Some(exp) = claims.expires_at {
        if opts.now_unix > exp {
            return Err(VerifyError::Expired);
        }
    }
    if let Some(bound) = &claims.fingerprint {
        match &opts.local_fingerprint {
            None => return Err(VerifyError::FingerprintMissing),
            Some(local) => {
                let effective_k =
                    core::cmp::max(opts.fp_threshold, claims.fp_min.unwrap_or(0) as usize);
                if !fingerprint_matches(bound, local, effective_k) {
                    return Err(VerifyError::FingerprintMismatch);
                }
            }
        }
    }

    let stored = opts.anchor_unix.unwrap_or(opts.now_unix);
    let next = next_anchor(stored, opts.now_unix);

    Ok(VerifiedLicense {
        claims,
        next_anchor: next,
    })
}
