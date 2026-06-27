//! Machine-fingerprint matching (FR-015, AD-003). The bound fingerprint is a list of
//! per-signal salted hashes (e.g. machine GUID, MAC, CPU, OS install id, disk serial).
//! A match requires at least K positionally-equal, non-empty signals so that swapping
//! one component (RAM/disk) does not break an otherwise valid node-locked license.

/// Default K in the K-of-N match (clarified default: 3 of 5).
pub const DEFAULT_FP_THRESHOLD: usize = 3;

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
