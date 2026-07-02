//! T021 / T022 (US1, SC-001, SC-009, FR-001/009/018/020): the real C-ABI proof.
//!
//! - **T021**: compile + link + run the C reference (`c-abi/examples/verify.c`) against the built
//!   cdylib + generated header. A valid token verifies offline and reads an entitlement; tampered
//!   and expired tokens are rejected with their distinct reason codes.
//! - **T022**: the allocate/verify/free lifecycle over the *same* `extern "C"` entry points is
//!   leak-free, asserted by balanced handle accounting ([`ls_ffi::outstanding_handles`]).
//!
//! These tests need a C compiler (gcc/cc/clang). The host toolchain is `windows-gnu`, so mingw
//! gcc links cleanly against the cargo-built import library.

mod common;

use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// `target/<profile>/` — where the cdylib and import lib live (test exe is in `.../deps/`).
fn target_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("current exe path");
    exe.ancestors()
        .nth(2)
        .expect("target/<profile> is two levels above the test exe")
        .to_path_buf()
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// First working C compiler among gcc/cc/clang, or panic (the test must run for real).
fn find_cc() -> &'static str {
    for cc in ["gcc", "cc", "clang"] {
        if Command::new(cc).arg("--version").output().is_ok() {
            return cc;
        }
    }
    panic!("no C compiler (gcc/cc/clang) found on PATH; required for the C-ABI integration test");
}

fn hex32(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Compile the C sample once; returns the path to the built executable.
fn compile_sample() -> PathBuf {
    let cc = find_cc();
    let include = crate_dir().join("../c-abi/include");
    let source = crate_dir().join("../c-abi/examples/verify.c");
    let libdir = target_dir();
    let exe = std::env::temp_dir().join(if cfg!(windows) {
        "ls_ffi_verify_sample.exe"
    } else {
        "ls_ffi_verify_sample"
    });

    assert!(source.exists(), "C sample missing: {}", source.display());
    assert!(
        include.join("licensesrv.h").exists(),
        "generated header missing: {}",
        include.join("licensesrv.h").display()
    );

    let status = Command::new(cc)
        .arg(&source)
        .arg(format!("-I{}", include.display()))
        .arg(format!("-L{}", libdir.display()))
        .arg("-lls_ffi")
        .arg("-o")
        .arg(&exe)
        .status()
        .expect("failed to launch C compiler");
    assert!(status.success(), "C sample failed to compile/link");
    exe
}

struct Run {
    code: i32,
    stdout: String,
}

/// Run the compiled sample with the cdylib discoverable on PATH (it links the import lib).
fn run_sample(exe: &Path, args: &[&str]) -> Run {
    let libdir = target_dir();
    let path = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let new_path = format!("{}{}{}", libdir.display(), sep, path);

    let out = Command::new(exe)
        .args(args)
        .env("PATH", new_path)
        // Also help non-Windows dynamic loaders find the .so next to the import target.
        .env("LD_LIBRARY_PATH", libdir.display().to_string())
        .output()
        .expect("failed to run compiled C sample");
    Run {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
    }
}

#[test]
fn c_sample_verifies_valid_and_rejects_tampered_and_expired() {
    let (sk, pk) = common::keypair();
    let token = common::sign(&common::base_claims(), &sk);
    let tampered = common::tamper(&token);
    let pk_hex = hex32(&pk);
    let now = common::NOW.to_string();
    let expired_now = "1950000000"; // past base_claims().expires_at (1_900_000_000)

    let exe = compile_sample();

    // Valid: verifies offline, reads entitlements.
    let valid = run_sample(&exe, &[&token, common::KID, &pk_hex, &now, "pro"]);
    assert_eq!(valid.code, 0, "valid token must verify; stdout=\n{}", valid.stdout);
    assert!(valid.stdout.contains("code=0"), "stdout=\n{}", valid.stdout);
    assert!(valid.stdout.contains("pro=1"), "entitlement readable; stdout=\n{}", valid.stdout);
    assert!(valid.stdout.contains("seats=5"), "int limit readable; stdout=\n{}", valid.stdout);

    // Tampered: BadSignature (code 5), rejected, nothing unlocked.
    let tamper = run_sample(&exe, &[&tampered, common::KID, &pk_hex, &now, "pro"]);
    assert_eq!(tamper.code, 1, "tampered token must be rejected");
    assert!(tamper.stdout.contains("code=5"), "BadSignature; stdout=\n{}", tamper.stdout);
    assert!(!tamper.stdout.contains("pro=1"), "nothing unlocked on tamper");

    // Expired: Expired (code 6), rejected.
    let expired = run_sample(&exe, &[&token, common::KID, &pk_hex, expired_now, "pro"]);
    assert_eq!(expired.code, 1, "expired token must be rejected");
    assert!(expired.stdout.contains("code=6"), "Expired; stdout=\n{}", expired.stdout);
}

#[test]
fn c_abi_lifecycle_is_leak_free_by_accounting() {
    // Drive the actual extern "C" entry points (the same ones the C program calls) in-process and
    // assert the handle count returns to baseline — a measurable leak check (FR-020, SC-009).
    use ls_ffi::capi::{
        ls_keyring_add, ls_keyring_free, ls_keyring_new, ls_result_code, ls_result_free, ls_verify,
    };

    let (sk, pk) = common::keypair();
    let token = common::sign(&common::base_claims(), &sk);
    let token_c = CString::new(token).unwrap();
    let key_id_c = CString::new(common::KID).unwrap();

    let baseline = ls_ffi::outstanding_handles();

    for _ in 0..2_000 {
        // SAFETY: all pointers are live for the duration of each call and freed exactly once.
        unsafe {
            let kr = ls_keyring_new();
            assert!(!kr.is_null());
            assert_eq!(ls_keyring_add(kr, key_id_c.as_ptr(), pk.as_ptr()), ls_ffi::reason::OK);

            let r = ls_verify(kr, token_c.as_ptr(), common::NOW, std::ptr::null(), std::ptr::null(), 0);
            assert!(!r.is_null());
            assert_eq!(ls_result_code(r), ls_ffi::reason::OK);

            ls_result_free(r);
            ls_keyring_free(kr);
        }
    }

    assert_eq!(
        ls_ffi::outstanding_handles(),
        baseline,
        "every allocated handle must be freed (no leak)"
    );
}
