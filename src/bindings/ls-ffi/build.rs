//! Build script: generate the authoritative C header (T019, FR-001) from the crate's
//! `extern "C"` surface using cbindgen. The header is written to the C-ABI binding's include
//! directory so the C sample and integration test compile against it. Skipped on `wasm32`
//! (the WASM binding's surface is `wasm-bindgen`, not a C header).

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/reason.rs");
    println!("cargo:rerun-if-changed=cbindgen.toml");

    // Only native targets produce the C header.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("wasm32") {
        return;
    }

    let crate_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set by cargo");
    let header = Path::new(&crate_dir).join("../c-abi/include/licensesrv.h");

    match cbindgen::generate(&crate_dir) {
        Ok(bindings) => {
            bindings.write_to_file(&header);
        }
        // Don't fail the whole build on a header-gen hiccup; surface it loudly instead. The CI
        // c-abi job additionally asserts the header exists (FR-017), so a real miss still fails.
        Err(e) => {
            println!("cargo:warning=cbindgen header generation failed: {e}");
        }
    }
}
