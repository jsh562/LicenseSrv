//! Monotonic clock anchor (FR-012, AD-001). A purely offline `expires_at` check is
//! defeated by setting the clock backward. The host persists the highest timestamp it
//! has ever observed (server responses, file mtimes, prior `now`); verification rejects
//! a `now` that precedes that anchor by more than an allowed skew.

/// Default tolerated backward skew: 48 hours (clarified default).
pub const DEFAULT_SKEW_SECS: i64 = 48 * 3600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub highest_seen: i64,
}

impl Anchor {
    pub fn new(initial: i64) -> Self {
        Self { highest_seen: initial }
    }

    /// Record a freshly observed trustworthy timestamp.
    pub fn observe(&mut self, t: i64) {
        if t > self.highest_seen {
            self.highest_seen = t;
        }
    }

    /// True when `now` is implausibly earlier than the highest timestamp ever seen.
    pub fn rolled_back(&self, now: i64, skew_secs: i64) -> bool {
        now < self.highest_seen - skew_secs
    }
}
