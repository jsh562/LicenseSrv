//! Typed entitlement resolution (TR-007, TR-018). Absent boolean → false; absent integer
//! → `None` (the caller supplies a default); a present value of an unknown/reserved type
//! (`EntValue::Other`) is treated as absent (ignored) for forward compatibility.

use alloc::collections::BTreeMap;
use alloc::string::String;

use crate::token::EntValue;

/// Resolve a boolean entitlement. An integer is truthy when > 0; absent or unknown → false.
pub fn resolve_bool(entitlements: &BTreeMap<String, EntValue>, key: &str) -> bool {
    match entitlements.get(key) {
        Some(EntValue::Bool(b)) => *b,
        Some(EntValue::Int(n)) => *n > 0,
        _ => false,
    }
}

/// Resolve an integer entitlement limit; absent, boolean, or unknown-typed → `None`.
pub fn resolve_int(entitlements: &BTreeMap<String, EntValue>, key: &str) -> Option<i64> {
    match entitlements.get(key) {
        Some(EntValue::Int(n)) => Some(*n),
        _ => None,
    }
}
