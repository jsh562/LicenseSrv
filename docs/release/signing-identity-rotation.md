# Runbook: rotate the release signing identity

**RR-004 · OR-004/OR-012.** LicenseSrv releases are signed **keyless** — there is **no private key to rotate,
escrow, or leak.** The "identity" operators trust is the **GitHub Actions OIDC identity** of the release workflow:

```
identity : https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/<tag>
issuer   : https://token.actions.githubusercontent.com
```

Every signature is bound to that identity, certified short-lived by Fulcio, and recorded in the public Rekor
transparency log. "Rotation" therefore means **the trusted identity string changes** — and operators must be told,
because their `cosign verify --certificate-identity[-regexp]` pin is what enforces authenticity.

> Because there is no long-lived key, there is nothing to revoke on a key-compromise basis. The threat model shifts
> from "protect a secret" to "control who can assume the release identity and announce identity changes clearly."

---

## When the identity changes

| Trigger | Effect on the pinned identity | Operator impact |
|---------|-------------------------------|-----------------|
| Repo renamed / moved org | `<owner>/<repo>` changes | Must re-pin |
| Release workflow file renamed/moved | `…/.github/workflows/<name>.yml` changes | Must re-pin |
| Tag naming scheme changes | The `@refs/tags/…` suffix pattern changes | Must update the regexp |
| GitHub changes the OIDC issuer | `--certificate-oidc-issuer` changes | Must re-pin (rare, announced by GitHub) |

Routine per-release tags (`v1.2.0` → `v1.2.1`) are **not** a rotation — the `v.*` regexp already covers them.

---

## Rotation procedure

1. **Decide and record the new identity.** Write down the exact new certificate-identity string and issuer.
2. **Update the pipeline's own self-verify** in [`.github/workflows/release.yml`](../../.github/workflows/release.yml):
   the `self-verify` step's `--certificate-identity-regexp` must match the new identity, or the very next release
   fails self-verify (fail-closed — good: it proves the docs and pipeline agree).
3. **Update [verify.md](verify.md)** — the identity table and every `cosign verify` / `verify-blob` /
   `verify-attestation` example — so operators copy the correct pin.
4. **Cut a release on the new identity** and confirm `self-verify` passes end-to-end.
5. **Announce to operators (critical):** publish the new identity through your release notes AND an out-of-band
   channel operators already trust (mailing list, status page, signed advisory). Include: old identity, new identity,
   the first tag signed under the new identity, and the transition window.
6. **Overlap window:** during transition, operators may accept either identity (a broadened regexp or two verify
   passes). Keep it short; announce the end date; then drop the old identity from `verify.md`.

---

## What operators must do

- Re-pin `--certificate-identity` / `--certificate-identity-regexp` (and `--certificate-oidc-issuer` if it changed)
  to the announced new value **before** deploying any release signed under it.
- **Verify the announcement's provenance.** A signing-identity change is exactly what an attacker would forge. Trust
  it only via a channel that predates and is independent of the change — never solely from a link in the same release.
- Until re-pinned, keep verifying against the **old** identity. If a release verifies under neither the old nor the
  announced new identity, **do not deploy** and report it — see the fail-closed table in [verify.md](verify.md).

---

## Compromise / abuse response

There is no key to exfiltrate, so the realistic abuse is **someone gaining the ability to run the release workflow**
(a malicious `release.yml` change or a compromised maintainer/runner). Response:

1. Revoke the offending access; lock the branch/tag protections and required reviews on `release.yml`.
2. Enumerate every tag/release signed during the exposure window (Rekor is append-only — the log itself is the audit
   trail; query it by the release identity).
3. Yank the affected GHCR images + GitHub releases; notify operators of the exact affected digests via the
   out-of-band channel and instruct them to roll back to the last known-good verified digest.
4. Harden (require reviews on workflow changes, restrict who can push `v*` tags, pin runners) and rotate the identity
   per the procedure above so future releases carry a distinct, clean identity.
