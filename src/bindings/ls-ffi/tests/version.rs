//! T030 (US4, SC-011, FR-012/FR-022): a binding/core or token-format mismatch is detectable via
//! the host-queryable version word, before any verify — never silent.

use ls_ffi::{ls_abi_version, ABI_MAJOR, ABI_MINOR, REASON_SET_REV};

fn format_version() -> u32 {
    verifier_core::FORMAT_VERSION as u32
}

#[test]
fn abi_version_packs_the_documented_fields() {
    let v = ls_abi_version();
    assert_eq!((v >> 24) & 0xff, ABI_MAJOR, "major");
    assert_eq!((v >> 16) & 0xff, ABI_MINOR, "minor");
    assert_eq!((v >> 8) & 0xff, format_version(), "token-format version");
    assert_eq!(v & 0xff, REASON_SET_REV, "reason-set revision");
}

#[test]
fn a_token_format_mismatch_is_detectable_before_verify() {
    let actual = ls_abi_version();

    // A host built against a DIFFERENT token-format version computes a different expected word, so
    // a simple equality check at load surfaces the mismatch (FR-012/FR-022) — no silent accept.
    let expected_other_format =
        (ABI_MAJOR << 24) | (ABI_MINOR << 16) | ((format_version() + 1) << 8) | REASON_SET_REV;
    assert_ne!(actual, expected_other_format, "a differing format version must change the version word");

    // The matching expectation agrees — no false mismatch.
    let expected_match =
        (ABI_MAJOR << 24) | (ABI_MINOR << 16) | (format_version() << 8) | REASON_SET_REV;
    assert_eq!(actual, expected_match);
}

#[test]
fn a_reason_set_revision_bump_changes_the_version_word() {
    // Freezing the reason map is a contract; a revision bump must be visible to hosts.
    let actual = ls_abi_version();
    let expected_other_rev =
        (ABI_MAJOR << 24) | (ABI_MINOR << 16) | (format_version() << 8) | (REASON_SET_REV + 1);
    assert_ne!(actual, expected_other_rev);
}
