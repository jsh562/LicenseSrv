#ifndef LICENSESRV_H
#define LICENSESRV_H

#pragma once

/* Generated from the ls-ffi crate by cbindgen. DO NOT EDIT BY HAND. */

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

// Binding ABI major version. A change to a frozen reason-code integer or an exported symbol
// bumps this (breaking ABI change).
#define ABI_MAJOR 0

// Binding ABI minor version. Backward-compatible additions bump this.
#define ABI_MINOR 1

// Revision of the frozen reason-code map ([`reason`]); bump whenever the map changes (FR-022).
#define REASON_SET_REV 1

// Verification succeeded.
#define OK 0

// A future `VerifyError` variant that has not yet been assigned a stable code. The core enum is
// `#[non_exhaustive]`; if it gains a variant, that variant MUST be mapped explicitly in
// [`reason_code`] (and `REASON_SET_REV` bumped) before a binding ships. Surfacing a distinct
// `253` rather than silently reusing another code makes an unmapped variant detectable.
#define UNMAPPED 253

// Null or invalid handle, or malformed host input (e.g. non-UTF-8 token) — FR-016. This is a
// *misuse* signal, deliberately distinct from any genuine verification outcome.
#define BAD_ARGUMENT 254

// A panic was caught at the FFI boundary, or a non-unwinding fault occurred (FR-005). Distinct
// from every verification outcome so a host can tell "the verifier faulted" from "the license
// is invalid".
#define INTERNAL 255

// Opaque handle owning a trusted [`Keyring`]. Created with [`LsKeyring::boxed`], freed once via
// [`free_keyring`]. The inner keyring is never exposed across the boundary.
//
typedef struct LsKeyring LsKeyring;

// Opaque handle holding one verification outcome: a stable reason code and, on success, the
// verified license for entitlement reads. Created by [`ls_ffi_verify`], freed once via
// [`free_result`].
//
typedef struct LsResult LsResult;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

// The packed, host-queryable ABI/format version (FR-012, FR-022). Compare at load to detect
// a binding/core or token-format mismatch before any verify.
uint32_t ls_abi_version(void);

// Allocate a new, empty trusted keyring. Returns `NULL` only on allocation failure. The host
// MUST free it exactly once with [`ls_keyring_free`].
LsKeyring *ls_keyring_new(void);

// Trust a 32-byte Ed25519 public key under the NUL-terminated UTF-8 `key_id`. Returns [`OK`],
// or [`BAD_ARGUMENT`] for a null handle/key_id/public_key, non-UTF-8 key_id, or an invalid
// key. `public_key` must point to exactly 32 readable bytes.
//
// # Safety
// `keyring` is a live [`LsKeyring`]; `key_id` is a valid NUL-terminated C string; `public_key`
// points to 32 readable bytes.
uint32_t ls_keyring_add(LsKeyring *keyring, const char *key_id, const uint8_t *public_key);

// Free a keyring handle (no-op on `NULL`). See the crate-level ownership contract.
//
// # Safety
// `keyring` is null or a live handle from this crate, not freed again.
void ls_keyring_free(LsKeyring *keyring);

// Verify `token` fully offline against `keyring` at host time `now_unix`. Optional
// `anchor_unix` (null = none) enables rollback detection; optional `fingerprint`
// (null/`fingerprint_len` 0 = none) supplies this machine's signals. Returns a result handle
// the host inspects with `ls_result_*` and frees once with [`ls_result_free`]; returns `NULL`
// only on allocation failure. Never returns through a panic (caught → an `INTERNAL` result).
//
// # Safety
// `keyring` is null or a live handle; `token` is a valid NUL-terminated C string; `anchor_unix`
// is null or points to one `int64`; `fingerprint` is null or points to `fingerprint_len`
// NUL-terminated C strings.
LsResult *ls_verify(const LsKeyring *keyring,
                    const char *token,
                    int64_t now_unix,
                    const int64_t *anchor_unix,
                    const char *const *fingerprint,
                    uintptr_t fingerprint_len);

// The reason code of a result: [`OK`] on success, else a frozen failure/misuse code.
// Returns [`BAD_ARGUMENT`] if `result` is null.
//
// # Safety
// `result` is null or a live [`LsResult`] from this crate.
uint32_t ls_result_code(const LsResult *result);

// `true` iff verification succeeded and the NUL-terminated `key` is an enabled entitlement.
// `false` on null/invalid input — fail-closed.
//
// # Safety
// `result` is null or live; `key` is a valid NUL-terminated C string.
bool ls_result_has(const LsResult *result, const char *key);

// Writes the integer limit for `key` to `*out` and returns `true` when present; returns
// `false` (and leaves `*out` untouched) when absent/not-an-integer/verify-failed/null input.
//
// # Safety
// `result` is null or live; `key` is a valid C string; `out` points to one writable `int64`.
bool ls_result_limit(const LsResult *result, const char *key, int64_t *out);

// Writes the anchor the host SHOULD persist after a successful verify to `*out` and returns
// `true`; returns `false` on failure/null input.
//
// # Safety
// `result` is null or live; `out` points to one writable `int64`.
bool ls_result_next_anchor(const LsResult *result, int64_t *out);

// Free a result handle (no-op on `NULL`).
//
// # Safety
// `result` is null or a live handle from this crate, not freed again.
void ls_result_free(LsResult *result);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* LICENSESRV_H */
