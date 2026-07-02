//! `ls-ffi` — the single thin FFI surface over [`verifier_core`] (ADR-0002, Principle III).
//!
//! This crate implements **no cryptography**. It adapts the one core's offline
//! [`verifier_core::verify`] into a shape every language binding can call: a stable reason-code
//! map ([`reason`]), a panic guard ([`guard`]), opaque heap handles with an explicit
//! allocate/free ownership contract, and a typed verify entry exposing the full offline-verify
//! surface (FR-004, FR-007). The C ABI (`extern "C"`), WASM (`wasm-bindgen`), and UniFFI
//! bindings are thin wrappers over the items defined here, so all three behave identically.
//!
//! ## Memory-ownership contract (FR-008, FR-015, FR-016)
//! Opaque handles ([`LsKeyring`], [`LsResult`]) are heap-allocated by the binding and returned
//! to the host as raw pointers. The host MUST free each handle **exactly once** with its
//! matching `*_free` function and MUST NOT use a handle after freeing it. Inputs (tokens, key
//! bytes, fingerprint strings) are **borrowed** for the duration of a call and never retained.
//! Misuse that the library can detect — a null or freed-to-null pointer — yields a defined
//! [`reason::BAD_ARGUMENT`] / no-op rather than undefined behavior.
//!
//! ## No secret leakage (FR-014)
//! Nothing here logs, and no returned value or diagnostic carries key bytes, raw token bytes,
//! the keyring, or fingerprint data. A successful verify exposes only the license's own
//! non-secret claims (entitlements, anchor) via [`LsResult`]; a failure exposes only a category
//! code. There are no `print`/`eprint`/`log` calls on any path, including errors.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod guard;
pub mod reason;

// The WASM (web/Node/Electron) surface. Only compiled for wasm32, where wasm-bindgen is the
// binding mechanism instead of the C ABI.
#[cfg(target_arch = "wasm32")]
mod wasm;

// The UniFFI generated-binding surface (P2). `#[path]` keeps the file named uniffi.rs (per the
// task) while the module is `uniffi_api`, so it does not shadow the `uniffi` crate.
#[cfg(feature = "uniffi")]
#[path = "uniffi.rs"]
mod uniffi_api;

// UniFFI scaffolding for the `licensesrv` namespace (P2). `uniffi` here is the crate.
#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!("licensesrv");

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;

use verifier_core::{verify as core_verify, Keyring, VerifiedLicense, VerifyOptions, FORMAT_VERSION};

pub use reason::{reason_code, BAD_ARGUMENT, INTERNAL, OK};

// ---------------------------------------------------------------------------------------------
// ABI / version contract (FR-012, FR-022)
// ---------------------------------------------------------------------------------------------

/// Binding ABI major version. A change to a frozen reason-code integer or an exported symbol
/// bumps this (breaking ABI change).
pub const ABI_MAJOR: u32 = 0;
/// Binding ABI minor version. Backward-compatible additions bump this.
pub const ABI_MINOR: u32 = 1;
/// Revision of the frozen reason-code map ([`reason`]); bump whenever the map changes (FR-022).
pub const REASON_SET_REV: u32 = 1;

use core::sync::atomic::{AtomicI64, Ordering};

/// Net count of live opaque handles this crate has allocated (allocations minus frees). A host
/// that pairs every `*_new`/result with its `*_free` returns this to its starting value; the
/// C-ABI leak test asserts that balance as a measurable leak check (FR-020). The cost is one
/// relaxed atomic per handle op — negligible — and it doubles as a cheap diagnostic.
static OUTSTANDING_HANDLES: AtomicI64 = AtomicI64::new(0);

/// Net live opaque handles allocated by this crate. Used by the leak-accounting test (FR-020).
pub fn outstanding_handles() -> i64 {
    OUTSTANDING_HANDLES.load(Ordering::Relaxed)
}

/// A packed, host-queryable version word: `(ABI_MAJOR<<24)|(ABI_MINOR<<16)|(FORMAT_VERSION<<8)|REASON_SET_REV`.
///
/// A host computes the value it was built against and compares at load/init; any difference
/// surfaces a binding/core or token-format mismatch **before** any verify is attempted, so a
/// mismatch is never silent (FR-012, FR-022). `FORMAT_VERSION` is the core's frozen `LIC1`
/// envelope version.
pub fn ls_abi_version() -> u32 {
    (ABI_MAJOR << 24) | (ABI_MINOR << 16) | ((FORMAT_VERSION as u32) << 8) | REASON_SET_REV
}

// ---------------------------------------------------------------------------------------------
// Opaque handles (FR-008, FR-016)
// ---------------------------------------------------------------------------------------------

/// Opaque handle owning a trusted [`Keyring`]. Created with [`LsKeyring::boxed`], freed once via
/// [`free_keyring`]. The inner keyring is never exposed across the boundary.
///
/// cbindgen:opaque
pub struct LsKeyring {
    inner: Keyring,
}

impl LsKeyring {
    /// An empty keyring handle held by value (no heap accounting). Used by the WASM surface, where
    /// the runtime owns the wrapper and drops it automatically.
    pub(crate) fn empty() -> LsKeyring {
        LsKeyring {
            inner: Keyring::new(),
        }
    }

    /// Allocate an empty keyring handle on the heap and hand back its owning pointer.
    pub fn boxed() -> *mut LsKeyring {
        OUTSTANDING_HANDLES.fetch_add(1, Ordering::Relaxed);
        Box::into_raw(Box::new(LsKeyring::empty()))
    }

    /// Trust a 32-byte Ed25519 public key under `key_id`. Returns [`OK`] or [`BAD_ARGUMENT`] if
    /// the bytes are not a valid public key.
    pub fn add(&mut self, key_id: &str, public_key: &[u8; 32]) -> u32 {
        match self.inner.add(key_id, public_key) {
            Ok(()) => OK,
            Err(_) => BAD_ARGUMENT,
        }
    }

    fn keyring(&self) -> &Keyring {
        &self.inner
    }
}

/// Opaque handle holding one verification outcome: a stable reason code and, on success, the
/// verified license for entitlement reads. Created by [`ls_ffi_verify`], freed once via
/// [`free_result`].
///
/// cbindgen:opaque
pub struct LsResult {
    code: u32,
    verified: Option<VerifiedLicense>,
}

impl LsResult {
    /// The stable reason code: [`OK`] on success, otherwise a frozen failure/misuse code.
    pub fn code(&self) -> u32 {
        self.code
    }

    /// True when verification succeeded and `key` is an enabled entitlement (bool true / int > 0).
    pub fn has(&self, key: &str) -> bool {
        self.verified.as_ref().is_some_and(|v| v.has(key))
    }

    /// The integer limit for `key`, or `None` when absent / not an integer / verify failed.
    pub fn limit(&self, key: &str) -> Option<i64> {
        self.verified.as_ref().and_then(|v| v.limit(key))
    }

    /// The anchor the host SHOULD persist after a successful verify (`max(prior, now)`), or
    /// `None` on failure (FR-019 anti-rollback bookkeeping).
    pub fn next_anchor(&self) -> Option<i64> {
        self.verified.as_ref().map(|v| v.next_anchor)
    }

    /// A bare failure/misuse outcome carrying only a code and no verified license. Used for the
    /// `BAD_ARGUMENT` (null/invalid input) and `INTERNAL` (caught panic) paths of the C ABI; the
    /// WASM surface reaches its codes through the shared verify entry, so this is unused there.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub(crate) fn failure(code: u32) -> Self {
        LsResult {
            code,
            verified: None,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Handle null/use-after-free guards (FR-015, FR-016)
// ---------------------------------------------------------------------------------------------

/// Borrow `*const T` as `&T`, or `None` if null (FR-016). Every binding entry uses this so a
/// null/invalid handle returns [`BAD_ARGUMENT`] instead of dereferencing null.
///
/// # Safety
/// `p` must be either null or a valid pointer previously returned by this crate and not yet
/// freed. A dangling (freed, non-null) pointer is the host's contract violation and is not
/// detectable here; the host MUST null its pointer after freeing (see crate-level contract).
pub(crate) unsafe fn as_ref<'a, T>(p: *const T) -> Option<&'a T> {
    p.as_ref()
}

/// Mutable counterpart to [`as_ref`]. Used by the `extern "C"` keyring-mutation entries (T017);
/// retained here as part of the shared handle-guard helper set.
///
/// # Safety
/// Same contract as [`as_ref`]; additionally the host must not alias the handle.
#[allow(dead_code)]
pub(crate) unsafe fn as_mut<'a, T>(p: *mut T) -> Option<&'a mut T> {
    p.as_mut()
}

/// Free a heap handle previously produced by this crate, consuming its pointer. A null pointer is
/// a defined **no-op** (FR-015). Calling this more than once on the same non-null pointer, or
/// using a handle after freeing, is the host's contract violation (free exactly once, never use
/// after free); we cannot detect a dangling non-null pointer, so the host MUST null its pointer
/// after this call.
///
/// # Safety
/// `p` is null or a live pointer from this crate that is not freed again.
pub(crate) unsafe fn free_boxed<T>(p: *mut T) {
    if !p.is_null() {
        OUTSTANDING_HANDLES.fetch_sub(1, Ordering::Relaxed);
        drop(Box::from_raw(p));
    }
}

/// Free an [`LsKeyring`] handle (see [`free_boxed`]).
///
/// # Safety
/// See [`free_boxed`].
pub unsafe fn free_keyring(p: *mut LsKeyring) {
    free_boxed(p);
}

/// Free an [`LsResult`] handle (see [`free_boxed`]).
///
/// # Safety
/// See [`free_boxed`].
pub unsafe fn free_result(p: *mut LsResult) {
    free_boxed(p);
}

/// The null/invalid-handle guard the C ABI applies before a verify: [`OK`] if `keyring` is a
/// non-null handle, else [`BAD_ARGUMENT`] (FR-016). Exposed publicly so the guard is unit-testable
/// on its own and reused verbatim by the `extern "C"` entries rather than duplicated.
///
/// # Safety
/// `keyring` is null or a live [`LsKeyring`] pointer from this crate.
pub unsafe fn check_keyring_ptr(keyring: *const LsKeyring) -> u32 {
    match as_ref(keyring) {
        Some(_) => OK,
        None => BAD_ARGUMENT,
    }
}

// ---------------------------------------------------------------------------------------------
// The shared verify entry (FR-004, FR-007, FR-021)
// ---------------------------------------------------------------------------------------------

/// Typed inputs for one offline verification (FR-007, FR-021). Every field has a defined
/// type/encoding so every binding author interprets it identically:
/// - `token`: the `LIC1` token as a UTF-8 string.
/// - `keyring`: the trusted public keys (borrowed; never retained).
/// - `now_unix`: current time in unix seconds, supplied by the host (verification never reads a
///   clock itself — this keeps it deterministic, FR-019).
/// - `anchor_unix`: highest time ever observed, for rollback detection (optional).
/// - `fingerprint`: this machine's fingerprint signals, required only for machine-bound licenses.
pub struct VerifyInput<'a> {
    pub token: &'a str,
    pub keyring: &'a LsKeyring,
    pub now_unix: i64,
    pub anchor_unix: Option<i64>,
    pub fingerprint: Option<Vec<String>>,
}

/// The single verify entry every binding calls (FR-004). It builds [`VerifyOptions`] from the
/// typed inputs, runs the **one** core [`verifier_core::verify`], and maps the result to a
/// stable [`LsResult`]: [`OK`] + the verified license on success, or the frozen failure code on
/// error. This inner function performs no I/O and is itself panic-free; bindings still wrap their
/// public entries in [`guard::guard`] as defense in depth (FR-005).
pub fn ls_ffi_verify(input: &VerifyInput<'_>) -> LsResult {
    let mut opts = VerifyOptions::at(input.now_unix);
    if let Some(anchor) = input.anchor_unix {
        opts = opts.with_anchor(anchor);
    }
    if let Some(fp) = &input.fingerprint {
        opts = opts.with_fingerprint(fp.clone());
    }

    match core_verify(input.token, input.keyring.keyring(), &opts) {
        Ok(verified) => LsResult {
            code: OK,
            verified: Some(verified),
        },
        Err(err) => LsResult {
            code: reason_code(&err),
            verified: None,
        },
    }
}

/// Allocate an [`LsResult`] on the heap and return its owning pointer (used by the binding
/// surfaces that hand a result handle back to the host).
pub fn boxed_result(result: LsResult) -> *mut LsResult {
    OUTSTANDING_HANDLES.fetch_add(1, Ordering::Relaxed);
    Box::into_raw(Box::new(result))
}

// =============================================================================================
// C ABI (FR-001, FR-005, FR-008, FR-016). The native lingua-franca surface that C/C++/.NET hosts
// link against. Gated off `wasm32`, where `wasm-bindgen` is the surface instead. Every entry is
// `#[no_mangle] extern "C"`, validates its pointers (null → BAD_ARGUMENT, no deref), and runs
// inside the panic guard so no unwind crosses the boundary (caught → INTERNAL). The C header is
// generated from these signatures by `build.rs` (cbindgen, T019).
// =============================================================================================
#[cfg(not(target_arch = "wasm32"))]
pub mod capi {
    use super::*;
    use std::ffi::CStr;
    use std::os::raw::c_char;

    /// The packed, host-queryable ABI/format version (FR-012, FR-022). Compare at load to detect
    /// a binding/core or token-format mismatch before any verify.
    #[no_mangle]
    pub extern "C" fn ls_abi_version() -> u32 {
        super::ls_abi_version()
    }

    /// Allocate a new, empty trusted keyring. Returns `NULL` only on allocation failure. The host
    /// MUST free it exactly once with [`ls_keyring_free`].
    #[no_mangle]
    pub extern "C" fn ls_keyring_new() -> *mut LsKeyring {
        guard_ptr(LsKeyring::boxed)
    }

    /// Trust a 32-byte Ed25519 public key under the NUL-terminated UTF-8 `key_id`. Returns [`OK`],
    /// or [`BAD_ARGUMENT`] for a null handle/key_id/public_key, non-UTF-8 key_id, or an invalid
    /// key. `public_key` must point to exactly 32 readable bytes.
    ///
    /// # Safety
    /// `keyring` is a live [`LsKeyring`]; `key_id` is a valid NUL-terminated C string; `public_key`
    /// points to 32 readable bytes.
    #[no_mangle]
    pub unsafe extern "C" fn ls_keyring_add(
        keyring: *mut LsKeyring,
        key_id: *const c_char,
        public_key: *const u8,
    ) -> u32 {
        crate::guard::guard(|| {
            let Some(kr) = as_mut(keyring) else {
                return BAD_ARGUMENT;
            };
            if key_id.is_null() || public_key.is_null() {
                return BAD_ARGUMENT;
            }
            let Ok(id) = CStr::from_ptr(key_id).to_str() else {
                return BAD_ARGUMENT;
            };
            let mut key = [0u8; 32];
            core::ptr::copy_nonoverlapping(public_key, key.as_mut_ptr(), 32);
            kr.add(id, &key)
        })
    }

    /// Free a keyring handle (no-op on `NULL`). See the crate-level ownership contract.
    ///
    /// # Safety
    /// `keyring` is null or a live handle from this crate, not freed again.
    #[no_mangle]
    pub unsafe extern "C" fn ls_keyring_free(keyring: *mut LsKeyring) {
        free_keyring(keyring);
    }

    /// Verify `token` fully offline against `keyring` at host time `now_unix`. Optional
    /// `anchor_unix` (null = none) enables rollback detection; optional `fingerprint`
    /// (null/`fingerprint_len` 0 = none) supplies this machine's signals. Returns a result handle
    /// the host inspects with `ls_result_*` and frees once with [`ls_result_free`]; returns `NULL`
    /// only on allocation failure. Never returns through a panic (caught → an `INTERNAL` result).
    ///
    /// # Safety
    /// `keyring` is null or a live handle; `token` is a valid NUL-terminated C string; `anchor_unix`
    /// is null or points to one `int64`; `fingerprint` is null or points to `fingerprint_len`
    /// NUL-terminated C strings.
    #[no_mangle]
    pub unsafe extern "C" fn ls_verify(
        keyring: *const LsKeyring,
        token: *const c_char,
        now_unix: i64,
        anchor_unix: *const i64,
        fingerprint: *const *const c_char,
        fingerprint_len: usize,
    ) -> *mut LsResult {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let Some(kr) = as_ref(keyring) else {
                return LsResult::failure(BAD_ARGUMENT);
            };
            if token.is_null() {
                return LsResult::failure(BAD_ARGUMENT);
            }
            let Ok(tok) = CStr::from_ptr(token).to_str() else {
                return LsResult::failure(BAD_ARGUMENT);
            };
            let anchor = if anchor_unix.is_null() {
                None
            } else {
                Some(*anchor_unix)
            };
            let fp = match collect_fingerprint(fingerprint, fingerprint_len) {
                Ok(fp) => fp,
                Err(()) => return LsResult::failure(BAD_ARGUMENT),
            };
            ls_ffi_verify(&VerifyInput {
                token: tok,
                keyring: kr,
                now_unix,
                anchor_unix: anchor,
                fingerprint: fp,
            })
        }));
        match outcome {
            Ok(result) => boxed_result(result),
            Err(_) => boxed_result(LsResult::failure(INTERNAL)),
        }
    }

    /// The reason code of a result: [`OK`] on success, else a frozen failure/misuse code.
    /// Returns [`BAD_ARGUMENT`] if `result` is null.
    ///
    /// # Safety
    /// `result` is null or a live [`LsResult`] from this crate.
    #[no_mangle]
    pub unsafe extern "C" fn ls_result_code(result: *const LsResult) -> u32 {
        match as_ref(result) {
            Some(r) => r.code(),
            None => BAD_ARGUMENT,
        }
    }

    /// `true` iff verification succeeded and the NUL-terminated `key` is an enabled entitlement.
    /// `false` on null/invalid input — fail-closed.
    ///
    /// # Safety
    /// `result` is null or live; `key` is a valid NUL-terminated C string.
    #[no_mangle]
    pub unsafe extern "C" fn ls_result_has(result: *const LsResult, key: *const c_char) -> bool {
        let (Some(r), false) = (as_ref(result), key.is_null()) else {
            return false;
        };
        match CStr::from_ptr(key).to_str() {
            Ok(k) => r.has(k),
            Err(_) => false,
        }
    }

    /// Writes the integer limit for `key` to `*out` and returns `true` when present; returns
    /// `false` (and leaves `*out` untouched) when absent/not-an-integer/verify-failed/null input.
    ///
    /// # Safety
    /// `result` is null or live; `key` is a valid C string; `out` points to one writable `int64`.
    #[no_mangle]
    pub unsafe extern "C" fn ls_result_limit(
        result: *const LsResult,
        key: *const c_char,
        out: *mut i64,
    ) -> bool {
        let (Some(r), false, false) = (as_ref(result), key.is_null(), out.is_null()) else {
            return false;
        };
        let Ok(k) = CStr::from_ptr(key).to_str() else {
            return false;
        };
        match r.limit(k) {
            Some(v) => {
                *out = v;
                true
            }
            None => false,
        }
    }

    /// Writes the anchor the host SHOULD persist after a successful verify to `*out` and returns
    /// `true`; returns `false` on failure/null input.
    ///
    /// # Safety
    /// `result` is null or live; `out` points to one writable `int64`.
    #[no_mangle]
    pub unsafe extern "C" fn ls_result_next_anchor(result: *const LsResult, out: *mut i64) -> bool {
        let (Some(r), false) = (as_ref(result), out.is_null()) else {
            return false;
        };
        match r.next_anchor() {
            Some(v) => {
                *out = v;
                true
            }
            None => false,
        }
    }

    /// Free a result handle (no-op on `NULL`).
    ///
    /// # Safety
    /// `result` is null or a live handle from this crate, not freed again.
    #[no_mangle]
    pub unsafe extern "C" fn ls_result_free(result: *mut LsResult) {
        free_result(result);
    }

    /// Collect an optional C array of NUL-terminated strings into `Option<Vec<String>>`.
    /// `Err(())` signals a null element or non-UTF-8 string (→ BAD_ARGUMENT).
    unsafe fn collect_fingerprint(
        fingerprint: *const *const c_char,
        len: usize,
    ) -> Result<Option<Vec<String>>, ()> {
        if fingerprint.is_null() || len == 0 {
            return Ok(None);
        }
        let mut signals = Vec::with_capacity(len);
        for i in 0..len {
            let p = *fingerprint.add(i);
            if p.is_null() {
                return Err(());
            }
            match CStr::from_ptr(p).to_str() {
                Ok(s) => signals.push(s.to_string()),
                Err(_) => return Err(()),
            }
        }
        Ok(Some(signals))
    }

    /// Pointer-returning analogue of [`guard::guard`]: a caught panic yields `NULL` (the only
    /// failure mode for the allocation-only entries `ls_keyring_new`).
    fn guard_ptr<T>(body: impl FnOnce() -> *mut T) -> *mut T {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
            Ok(p) => p,
            Err(_) => core::ptr::null_mut(),
        }
    }
}
