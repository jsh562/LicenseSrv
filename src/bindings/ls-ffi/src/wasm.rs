//! WASM surface (US2, FR-002): a `wasm-bindgen` wrapper over the **same** shared
//! [`crate::ls_ffi_verify`] the C ABI uses, so a token yields an identical reason code in both
//! bindings (FR-006). Consumable from browsers, Node, and Electron with no server call (offline).
//!
//! ## Panic / fault model (FR-005, T024)
//! On `wasm32-unknown-unknown` the panic strategy is `abort`, so an unwinding `catch_unwind` guard
//! cannot intercept a panic — a panic becomes a wasm trap, which FR-005 classifies as the
//! platform's terminal fault (out of scope for a defined return). Soundness therefore rests on the
//! core's fuzzed, panic-free parser (FR-013). Recoverable input faults are still mapped to defined
//! codes: a public key whose length is not 32 returns [`crate::reason::BAD_ARGUMENT`], matching the
//! C ABI. wasm-bindgen itself rejects a null/missing handle argument before Rust runs, so a null
//! handle cannot reach this code as UB.

use alloc::string::String;
use alloc::vec::Vec;

use wasm_bindgen::prelude::*;

use crate::{ls_ffi_verify, reason, LsKeyring, LsResult, VerifyInput};

/// The packed ABI/format version (FR-012, FR-022). A JS host compares this at load against the
/// value it was built for to detect a binding/core mismatch before any verify.
#[wasm_bindgen(js_name = abiVersion)]
pub fn abi_version() -> u32 {
    crate::ls_abi_version()
}

/// A trusted keyring (JS class `Keyring`). Built up with [`WasmKeyring::add`], then passed to
/// [`verify`]. The JS runtime owns and frees the instance.
#[wasm_bindgen(js_name = Keyring)]
pub struct WasmKeyring {
    inner: LsKeyring,
}

#[wasm_bindgen(js_class = Keyring)]
impl WasmKeyring {
    /// Create an empty keyring.
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmKeyring {
        WasmKeyring {
            inner: LsKeyring::empty(),
        }
    }

    /// Trust a 32-byte Ed25519 public key under `key_id`. Returns the [`reason`] code: `OK`, or
    /// `BAD_ARGUMENT` if the key is not exactly 32 bytes or is not a valid public key.
    pub fn add(&mut self, key_id: &str, public_key: &[u8]) -> u32 {
        match <[u8; 32]>::try_from(public_key) {
            Ok(key) => self.inner.add(key_id, &key),
            Err(_) => reason::BAD_ARGUMENT,
        }
    }
}

impl Default for WasmKeyring {
    fn default() -> Self {
        Self::new()
    }
}

/// One verification outcome (JS class `LicenseResult`): a stable reason `code`, plus entitlement
/// reads on success. Mirrors the C ABI `ls_result_*` accessors.
#[wasm_bindgen(js_name = LicenseResult)]
pub struct WasmResult {
    inner: LsResult,
}

#[wasm_bindgen(js_class = LicenseResult)]
impl WasmResult {
    /// The stable reason code: `0` (OK) on success, else a frozen failure/misuse code.
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> u32 {
        self.inner.code()
    }

    /// `true` iff verification succeeded and `key` is an enabled entitlement (fail-closed).
    pub fn has(&self, key: &str) -> bool {
        self.inner.has(key)
    }

    /// The integer limit for `key`, or `undefined` when absent / not an integer / verify failed.
    pub fn limit(&self, key: &str) -> Option<f64> {
        self.inner.limit(key).map(|v| v as f64)
    }

    /// The anchor the host SHOULD persist after a successful verify, or `undefined` on failure.
    #[wasm_bindgen(getter, js_name = nextAnchor)]
    pub fn next_anchor(&self) -> Option<f64> {
        self.inner.next_anchor().map(|v| v as f64)
    }
}

/// Verify a `LIC1` token fully offline (FR-002, FR-007). `nowUnix` is the host's current unix time
/// in seconds; the optional `anchorUnix` enables rollback detection; the optional `fingerprint`
/// supplies this machine's signals for a machine-bound license. Returns a [`WasmResult`].
#[wasm_bindgen]
pub fn verify(
    keyring: &WasmKeyring,
    token: &str,
    now_unix: f64,
    anchor_unix: Option<f64>,
    fingerprint: Option<Vec<String>>,
) -> WasmResult {
    let result = ls_ffi_verify(&VerifyInput {
        token,
        keyring: &keyring.inner,
        now_unix: now_unix as i64,
        anchor_unix: anchor_unix.map(|a| a as i64),
        fingerprint,
    });
    WasmResult { inner: result }
}
