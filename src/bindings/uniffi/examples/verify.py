"""Reference: verify a license fully offline in Python via the generated UniFFI binding
(US3, P2, FR-003). No network, no cryptography in Python — the one Rust core does the work.

Run: python src/bindings/uniffi/examples/verify.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# The generated binding module + its native library live in ../python.
sys.path.insert(0, os.path.join(HERE, "..", "python"))
import licensesrv  # noqa: E402


def main() -> int:
    # In a real app the token and trusted key ship with / are fetched out-of-band; here we reuse
    # the deterministic fixture produced by the Rust core (single source of truth for every binding).
    fixture_path = os.path.join(HERE, "..", "..", "wasm", "tests", "fixture.json")
    with open(fixture_path) as f:
        fx = json.load(f)

    key = licensesrv.TrustedKey(key_id=fx["keyId"], public_key=bytes(fx["publicKey"]))

    print("binding/core ABI version:", licensesrv.abi_version())

    outcome = licensesrv.verify_license(fx["token"], [key], fx["nowUnix"], "pro")
    print("reason code:", outcome.code)

    if outcome.code == 0 and outcome.entitled:
        seats = licensesrv.verify_license(fx["token"], [key], fx["nowUnix"], "seats")
        print("[OK] PRO unlocked - seats limit:", seats.limit)
        print("     persist next anchor:", outcome.next_anchor)
        return 0
    print("[FAIL] license invalid - feature stays locked")
    return 1


if __name__ == "__main__":
    sys.exit(main())
