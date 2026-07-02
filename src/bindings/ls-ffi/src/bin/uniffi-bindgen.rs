//! The uniffi-bindgen CLI (P2). Generates the language bindings (e.g. Python) from the built
//! library's embedded metadata (library mode). Built only under `--features uniffi`.

fn main() {
    uniffi::uniffi_bindgen_main()
}
