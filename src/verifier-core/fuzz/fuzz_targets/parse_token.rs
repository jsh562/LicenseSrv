#![no_main]
//! The token parser/verifier must never panic on arbitrary input — a panic across the
//! C ABI / WASM boundary is undefined behavior. This target drives `verify` with random
//! bytes interpreted as a token string. (A stable, non-nightly smoke version of this
//! property lives in `tests/verify.rs::malformed_inputs_never_panic`.)

use libfuzzer_sys::fuzz_target;
use verifier_core::{verify, Keyring, VerifyOptions};

fuzz_target!(|data: &[u8]| {
    if let Ok(s) = std::str::from_utf8(data) {
        let keyring = Keyring::new();
        let opts = VerifyOptions::at(0);
        let _ = verify(s, &keyring, &opts);
    }
});
