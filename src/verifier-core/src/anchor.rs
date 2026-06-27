//! Monotonic clock anchor (TR-005, AD-001). A purely offline `expires_at` check is
//! defeated by setting the clock backward. The host persists the highest timestamp it
//! has ever observed; verification rejects a `now` that precedes that anchor by more than
//! an allowed skew.

/// Default tolerated backward skew: 48 hours (clarified default).
pub const DEFAULT_SKEW_SECS: i64 = 48 * 3600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub highest_seen: i64,
}

impl Anchor {
    pub fn new(initial: i64) -> Self {
        Self {
            highest_seen: initial,
        }
    }

    /// Record a freshly observed trustworthy timestamp.
    pub fn observe(&mut self, t: i64) {
        if t > self.highest_seen {
            self.highest_seen = t;
        }
    }

    /// True when `now` is implausibly earlier than the highest timestamp ever seen.
    pub fn rolled_back(&self, now: i64, skew_secs: i64) -> bool {
        now < self.highest_seen.saturating_sub(skew_secs)
    }
}

/// The anchor value the host should persist after a successful verify: the maximum of the
/// stored anchor and the current time. A token's `issued_at` is intentionally **excluded**
/// so a future-dated token cannot poison the anchor and lock the host out (TR-005).
pub fn next_anchor(stored: i64, now: i64) -> i64 {
    if now > stored {
        now
    } else {
        stored
    }
}
