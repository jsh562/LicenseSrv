//! `verifier-core` — the single, write-once cryptographic core for offline license
//! verification (ADR-0002). It parses a `LIC1.` license token (ADR-0001), verifies its
//! Ed25519 signature against a pinned keyring, and evaluates expiry, clock-rollback,
//! machine fingerprint, and entitlements — with **no network access**.
//!
//! This crate is the only place license cryptography is implemented; every language
//! binding (C ABI, WASM, UniFFI) wraps it rather than reimplementing crypto.
//!
//! The crate is `no_std` + `alloc` (TR target) so it embeds in WASM, native, and
//! managed runtimes alike; enable the `std` feature to opt back into `std`.
//!
//! ## Stability (TR-016)
//! The public API follows semantic versioning. The license token format evolves
//! additively within the `LIC1.` envelope (`token_version`); a breaking byte-layout
//! change adopts a new `LIC2.` envelope rather than mutating `LIC1.`.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

mod anchor;
mod entitlement;
mod fingerprint;
mod keyring;
mod token;
mod verify;

pub use anchor::{next_anchor, Anchor, DEFAULT_SKEW_SECS};
pub use entitlement::{resolve_bool, resolve_int};
pub use fingerprint::{fingerprint_matches, DEFAULT_FP_THRESHOLD, FP_SLOTS};
pub use keyring::{InvalidPublicKey, KeyEntry, Keyring, MAX_KEYRING_KEYS};
pub use token::{
    issue, Claims, EntValue, FORMAT_VERSION, MAX_ENTITLEMENTS, MAX_TOKEN_BYTES, PREFIX, PREFIX_V2,
};
pub use verify::{verify, VerifiedLicense, VerifyError, VerifyOptions};

// Re-exported for callers that need to construct keys / sign tokens.
pub use ed25519_dalek::{SigningKey, VerifyingKey};
