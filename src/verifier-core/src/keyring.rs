//! A keyring of trusted Ed25519 public keys, selected by `key_id`. Clients pin a
//! keyring (not a single key) so signing keys can be rotated without breaking
//! already-issued licenses (TR-008, TR-011/ADR-0003).
//!
//! Each entry carries an optional offline validity window and a revoked flag (TR-017).
//! This metadata travels with the keyring artifact (published by the signing service),
//! NOT inside the signed token.

use alloc::collections::BTreeMap;
use alloc::string::String;

use ed25519_dalek::VerifyingKey;

/// Default maximum number of keys a keyring holds (TR-020); bounds key-selection cost.
pub const MAX_KEYRING_KEYS: usize = 32;

/// Returned when a 32-byte value is not a valid Ed25519 public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidPublicKey;

/// A trusted key plus its offline validity window (TR-017).
#[derive(Clone)]
pub struct KeyEntry {
    pub key: VerifyingKey,
    /// Inclusive lower bound (unix seconds); `None` = no lower bound.
    pub valid_from: Option<i64>,
    /// Exclusive upper bound (unix seconds); `None` = no upper bound.
    pub valid_until: Option<i64>,
    pub revoked: bool,
}

impl KeyEntry {
    /// A key trusted with no validity window and not revoked.
    pub fn always_valid(key: VerifyingKey) -> Self {
        Self {
            key,
            valid_from: None,
            valid_until: None,
            revoked: false,
        }
    }
}

#[derive(Default, Clone)]
pub struct Keyring {
    keys: BTreeMap<String, KeyEntry>,
}

impl Keyring {
    pub fn new() -> Self {
        Self::default()
    }

    /// Trust `public_key` (32 raw Ed25519 bytes) under `key_id`, with no validity window.
    pub fn add(
        &mut self,
        key_id: impl Into<String>,
        public_key: &[u8; 32],
    ) -> Result<(), InvalidPublicKey> {
        let vk = VerifyingKey::from_bytes(public_key).map_err(|_| InvalidPublicKey)?;
        self.insert(key_id, KeyEntry::always_valid(vk));
        Ok(())
    }

    /// Trust a full [`KeyEntry`] (with validity window / revoked flag) under `key_id`.
    pub fn add_entry(&mut self, key_id: impl Into<String>, entry: KeyEntry) {
        self.insert(key_id, entry);
    }

    fn insert(&mut self, key_id: impl Into<String>, entry: KeyEntry) {
        let key_id = key_id.into();
        // Allow overwriting an existing id; only the distinct-key count is bounded (TR-020).
        if self.keys.len() >= MAX_KEYRING_KEYS && !self.keys.contains_key(&key_id) {
            return;
        }
        self.keys.insert(key_id, entry);
    }

    pub fn get(&self, key_id: &str) -> Option<&KeyEntry> {
        self.keys.get(key_id)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}
