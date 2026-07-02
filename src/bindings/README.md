# Embeddable Verifier Bindings (E003) — Quickstart

Verify a license **offline** from any stack in minutes. Every binding wraps the **one** Rust
verifier core ([`src/verifier-core`](../verifier-core), epic E001) — no cryptography is
reimplemented per language (ADR-0002, Principle III), and the same token yields the **same reason
code** in every binding (FR-006).

| Binding | Path | Target | Priority |
|---------|------|--------|----------|
| C ABI (native, C/C++, .NET P/Invoke) | [`c-abi/`](c-abi/) | `x86_64`, `aarch64` cdylib + header | P1 |
| WASM (browser, Node, Electron) | [`wasm/`](wasm/) | `wasm32-unknown-unknown` | P1 |
| UniFFI generated (Python, Kotlin, Swift) | [`uniffi/`](uniffi/) | generated | P2 |

All three call the shared, panic-safe glue crate [`ls-ffi/`](ls-ffi/): one verify entry, an
explicit memory-ownership contract, and one reason-code map.

## Reason codes (identical across every binding)

| Code | Meaning | Code | Meaning |
|------|---------|------|---------|
| 0 | OK (valid) | 6 | Expired |
| 1 | Malformed | 7 | ClockRollback |
| 2 | UnsupportedVersion | 8 | FingerprintMismatch |
| 3 | UnknownKey | 9 | FingerprintMissing |
| 4 | KeyNotValid | 254 | BadArgument (null/invalid input) |
| 5 | BadSignature (tampered) | 255 | Internal (caught fault) |

You supply: the `LIC1` token, a trusted public key (32 raw Ed25519 bytes) under a `key_id`, the
current unix time, and optionally an anchor + machine fingerprint. You get back a reason code and,
on success, the entitlements.

## Prerequisites

Per [the binding assumptions](../../specs/00004-embeddable-verifier-bindings/spec.md): the ability
to link a native shared library **or** install/load the WASM package. No Rust toolchain and no
cryptography knowledge are required to *use* a binding. (Building the artifacts needs Rust +
`wasm-pack`; that is the maintainer path, not the integrator path.)

## Path A — C ABI (native / .NET), target < 30 min

```sh
# 1. Build the shared library + header (maintainer step; ships prebuilt to integrators).
cargo build --release -p ls-ffi          # -> target/release/{libls_ffi.so|.dll|.dylib}
                                         #    header -> src/bindings/c-abi/include/licensesrv.h

# 2. Compile + link your program against the header and library.
cc my_app.c -Isrc/bindings/c-abi/include -Ltarget/release -lls_ffi -o my_app
```

```c
#include "licensesrv.h"
LsKeyring *kr = ls_keyring_new();
ls_keyring_add(kr, key_id, public_key /* 32 bytes */);
LsResult *r = ls_verify(kr, token, now_unix, NULL, NULL, 0);   /* offline; no network */
if (ls_result_code(r) == OK && ls_result_has(r, "pro")) {
    /* unlock the feature */
}
ls_result_free(r);
ls_keyring_free(kr);   /* free each handle exactly once */
```

A complete, runnable reference is [`c-abi/examples/verify.c`](c-abi/examples/verify.c).

## Path B — WASM (browser / Node / Electron), target < 30 min

```sh
# 1. Build the package (maintainer step; publish to npm for integrators).
wasm-pack build src/bindings/ls-ffi --target nodejs --out-dir ../wasm/pkg --out-name licensesrv

# 2. Use it.
node src/bindings/wasm/examples/node-verify.mjs
```

```js
import { Keyring, verify } from './pkg/licensesrv.js';
const kr = new Keyring();
kr.add(keyId, new Uint8Array(publicKey));         // 32 bytes
const r = verify(kr, token, nowUnix);             // offline; no fetch
if (r.code === 0 && r.has('pro')) {
  // unlock the feature; r.limit('seats') reads an integer entitlement
}
```

A complete reference is [`wasm/examples/node-verify.mjs`](wasm/examples/node-verify.mjs).

## Version / mismatch check

Call `ls_abi_version()` (C) / `abiVersion()` (WASM) at load and compare against the value your app
was built for. A binding/core or token-format mismatch changes the value, so it is caught up front
rather than misbehaving at verify time (FR-012/FR-022).

## Supported target matrix (FR-017)

`x86_64` and `aarch64` (Linux/macOS/Windows) for the C ABI, `wasm32-unknown-unknown` for WASM, and
the UniFFI-generated languages (P2). An unsupported target fails at build/load — never at verify
time. CI builds every target and fails on a missing artifact: [`.github/workflows/bindings.yml`](../../.github/workflows/bindings.yml).

### Distribution (FR-010)

Each CI run publishes the per-target artifacts an integrator consumes: the C-ABI shared/static
library + header (`c-abi-<target>`) and the installable WASM npm package (`wasm-pkg`). The fuzz
entry gate, dependency scans (no CRITICAL, across Rust/WASM/UniFFI deps), and the ≥ 80% coverage
gate all run in the same workflow.

> Time-to-first-verify is measured in
> [the quickstart walkthrough log](#quickstart-walkthrough-timing-sc-004) below.

## Quickstart walkthrough timing (SC-004)

_Recorded by following this README from the prerequisites to a first successful offline verify._

Start = an integrator with the prerequisites (able to link the shared library or load the WASM
package) opens this quickstart. End = the documented sample returns a success verdict for the
supplied valid token. Measured command times (prebuilt artifacts, as an integrator receives them):

| Path | Step | Measured |
|------|------|----------|
| WASM | run `node examples/node-verify.mjs` → `code 0`, PRO unlocked | **~0.5 s** |
| C ABI | `cc verify.c -I… -L… -lls_ffi` compile+link, then run → `code=0` | **~0.3 s** compile + run |

Both reach a first successful **offline** verify in seconds of command time; even allowing for
reading the quickstart and wiring the calls into a host application, first-verify lands well under
the 30-minute bound (SC-004). The C sample and the Node sample above are the exact artifacts run.
