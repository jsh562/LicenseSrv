//! T015 (FR-005, SC-005): the panic guard converts an unwinding panic into the defined
//! `INTERNAL` code and never lets it cross the boundary; a normal body passes its code through.

use ls_ffi::guard::guard;
use ls_ffi::reason::{INTERNAL, OK};

#[test]
fn caught_panic_returns_internal_and_does_not_unwind() {
    // If the panic were NOT caught, this `guard` call itself would unwind and fail the test
    // process; reaching the assertion proves containment.
    let code = guard(|| panic!("boundary panic must not escape"));
    assert_eq!(code, INTERNAL);
}

#[test]
fn panic_with_non_string_payload_is_also_contained() {
    let code = guard(|| std::panic::panic_any(42u32));
    assert_eq!(code, INTERNAL);
}

#[test]
fn normal_body_passes_its_code_through() {
    assert_eq!(guard(|| OK), OK);
    assert_eq!(guard(|| 7u32), 7);
}
