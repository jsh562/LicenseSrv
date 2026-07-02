//! The panic guard that makes the FFI boundary sound (FR-005).
//!
//! No Rust panic may unwind across a C ABI / FFI boundary — doing so is undefined behavior.
//! Every binding entry point runs its body through [`guard`], which catches an unwinding panic
//! and converts it into the defined [`crate::reason::INTERNAL`] code instead.
//!
//! ## Non-unwinding faults (FR-005, T008)
//! Faults that do *not* unwind are handled by construction, not by `catch_unwind`:
//! - **Recoverable input faults** (null/invalid handle, non-UTF-8 token bytes) are validated at
//!   the boundary and returned as [`crate::reason::BAD_ARGUMENT`] before any core call — they
//!   never reach a panic.
//! - **Allocation failure** aborts the process under Rust's default allocator; together with a
//!   host-level trap (e.g. a `wasm32` trap) it is the platform's *terminal* fault and is out of
//!   scope for a defined return per FR-005.
//!
//! ## Platform note
//! On `wasm32-unknown-unknown` the default panic strategy is `abort`, so a panic becomes a trap
//! rather than an unwind `catch_unwind` can intercept. The WASM surface therefore relies on the
//! core's **panic-free, fuzzed** parser (FR-013) for soundness; this guard is the native (C ABI /
//! UniFFI) defense. The two together satisfy FR-005 across all binding surfaces.

/// Run `body` and return its reason code, converting any unwinding panic into
/// [`crate::reason::INTERNAL`]. `AssertUnwindSafe` is sound here because a caught panic produces
/// only an opaque integer return — the guard observes no possibly-broken invariant afterward.
#[cfg(feature = "std")]
pub fn guard<F: FnOnce() -> u32>(body: F) -> u32 {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(code) => code,
        Err(_) => crate::reason::INTERNAL,
    }
}

/// `no_std` fallback: there is no unwinding runtime to catch, so soundness rests entirely on the
/// core's fuzzed, panic-free parser (FR-013). Present so the crate's `std`-feature surface stays
/// uniform; the supported binding targets all build with `std`.
#[cfg(not(feature = "std"))]
pub fn guard<F: FnOnce() -> u32>(body: F) -> u32 {
    body()
}
