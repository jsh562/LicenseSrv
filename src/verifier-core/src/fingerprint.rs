//! Machine-fingerprint matching (TR-006, AD-005). The bound fingerprint is a list of
//! five positional salted hashes — `[machine-id, CPU, disk/volume, MAC, OS-install-id]`.
//! A match requires at least K positionally-equal, non-empty signals so that swapping one
//! component (RAM/disk) does not break an otherwise valid node-locked license.
//!
//! Signals are salted by the host/issuer before they reach this core; the core never sees
//! raw hardware identifiers or the salt (TR-014).

use alloc::string::String;

/// Default K in the K-of-N match (clarified default: 3 of 5).
pub const DEFAULT_FP_THRESHOLD: usize = 3;
/// The canonical number of signal slots, N.
pub const FP_SLOTS: usize = 5;

/// Returns true when at least `threshold` non-empty signals agree position-by-position.
pub fn fingerprint_matches(bound: &[String], local: &[String], threshold: usize) -> bool {
    let n = bound.len().min(local.len());
    let mut matches = 0usize;
    for i in 0..n {
        if !bound[i].is_empty() && bound[i] == local[i] {
            matches += 1;
        }
    }
    matches >= threshold
}
