//! `verifier-core` — the single, write-once cryptographic core for offline license
//! verification (ADR-0002). It parses a `LIC1.` license token (ADR-0001), verifies its
//! Ed25519 signature against a pinned keyring, and evaluates expiry, clock-rollback,
//! machine fingerprint, and entitlements — with **no network access**.
//!
//! This crate is the only place license cryptography is implemented; every language
//! binding (C ABI, WASM, UniFFI) wraps it rather than reimplementing crypto.

mod anchor;
mod fingerprint;
mod keyring;
mod token;
mod verify;

pub use anchor::{Anchor, DEFAULT_SKEW_SECS};
pub use fingerprint::{fingerprint_matches, DEFAULT_FP_THRESHOLD};
pub use keyring::Keyring;
pub use token::{issue, Claims, EntValue, FORMAT_VERSION, PREFIX};
pub use verify::{verify, VerifiedLicense, VerifyError, VerifyOptions};

// Re-exported for callers that need to construct keys / sign tokens.
pub use ed25519_dalek::{SigningKey, VerifyingKey};
