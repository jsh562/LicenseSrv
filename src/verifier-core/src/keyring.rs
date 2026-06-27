//! A keyring of trusted Ed25519 public keys, selected by `key_id`. Clients pin a
//! keyring (not a single key) so signing keys can be rotated without breaking
//! already-issued licenses (FR-011, ADR-0003).

use std::collections::BTreeMap;

use ed25519_dalek::VerifyingKey;

use crate::verify::VerifyError;

#[derive(Default, Clone)]
pub struct Keyring {
    keys: BTreeMap<String, VerifyingKey>,
}

impl Keyring {
    pub fn new() -> Self {
        Self::default()
    }

    /// Trust `public_key` (32 raw Ed25519 bytes) under `key_id`.
    pub fn add(&mut self, key_id: impl Into<String>, public_key: &[u8; 32]) -> Result<(), VerifyError> {
        let vk = VerifyingKey::from_bytes(public_key).map_err(|_| VerifyError::BadKey)?;
        self.keys.insert(key_id.into(), vk);
        Ok(())
    }

    pub fn add_verifying_key(&mut self, key_id: impl Into<String>, vk: VerifyingKey) {
        self.keys.insert(key_id.into(), vk);
    }

    pub fn get(&self, key_id: &str) -> Option<&VerifyingKey> {
        self.keys.get(key_id)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}
