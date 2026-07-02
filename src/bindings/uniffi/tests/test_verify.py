"""T036 (US3, P2, SC-006, FR-003): Python UniFFI smoke test. The generated binding verifies a
valid token offline and reads entitlements identical to the C-ABI/WASM bindings, and agrees on the
tampered/expired reason codes. Runnable with pytest OR directly: `python test_verify.py`.

This binding is P2 — non-blocking for the P1 MVP gate (US1 C-ABI + US2 WASM + US4).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))
import licensesrv  # noqa: E402


def _fixture():
    path = os.path.join(HERE, "..", "..", "wasm", "tests", "fixture.json")
    with open(path) as f:
        return json.load(f)


def _key(fx):
    return licensesrv.TrustedKey(key_id=fx["keyId"], public_key=bytes(fx["publicKey"]))


def test_valid_token_verifies_offline_and_reads_entitlements():
    fx = _fixture()
    out = licensesrv.verify_license(fx["token"], [_key(fx)], fx["nowUnix"], "pro")
    assert out.code == 0
    assert out.entitled is True
    # Integer entitlement, identical value to the other bindings.
    seats = licensesrv.verify_license(fx["token"], [_key(fx)], fx["nowUnix"], "seats")
    assert seats.limit == 5
    assert out.next_anchor is not None


def test_tampered_token_is_bad_signature_like_other_bindings():
    fx = _fixture()
    out = licensesrv.verify_license(fx["tampered"], [_key(fx)], fx["nowUnix"], "pro")
    assert out.code == 5  # BadSignature — same code as C-ABI and WASM
    assert out.entitled is False


def test_expired_token_is_rejected():
    fx = _fixture()
    out = licensesrv.verify_license(fx["token"], [_key(fx)], fx["expiredNow"], "pro")
    assert out.code == 6  # Expired


def test_abi_version_is_positive():
    assert licensesrv.abi_version() > 0


if __name__ == "__main__":
    tests = sorted((n, f) for n, f in globals().items() if n.startswith("test_") and callable(f))
    for name, fn in tests:
        fn()
        print("ok", name)
    print(f"all {len(tests)} passed")
