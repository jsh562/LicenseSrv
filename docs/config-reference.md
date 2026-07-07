# Configuration Reference (E006)

The License API is configured entirely from the environment (12-factor). Every runtime setting is listed
below. Configuration is validated once at startup: any missing or invalid **required** setting causes a
fail-fast exit (non-zero) that names the offending setting — the process never starts in a degraded state.

## Settings

| Variable | Purpose | Required | Default | Secret |
|----------|---------|----------|---------|--------|
| `DATABASE_URL` | PostgreSQL connection string (also used by the migrate job) | yes | — | **yes** |
| `API_KEY_SECRET` | HMAC secret for API-key + email hashing | yes | — | **yes** |
| `SIGNING_CUSTODIAN_SHARES` | Comma-separated base64 Shamir custodian shares that unlock the signing keystore | no¹ | — | **yes** |
| `HOST` | Listen address | no | `0.0.0.0` | no |
| `PORT` | Listen port | no | `8080` | no |
| `DB_POOL_MAX` | Max PostgreSQL pool connections | no | `10` | no |
| `SHUTDOWN_TIMEOUT_MS` | Graceful-shutdown drain window (enforced by OBJ7, P2) | no | `10000` | no |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | no | `info` | no |
| `NODE_ENV` | Node environment | no | `production` | no |
| `SIGNING_SIGNER` | Signer backend (`keystore` \| `kms`) — see E004 | no | `keystore` | no |
| `SIGNING_OVERLAP_SECONDS` | Key-rotation overlap window — see E004 | no | `2592000` | no |
| `ADMIN_SESSION_TTL_SECONDS` | Admin session lifetime (≤ 24h) — see E005 | no | `28800` | no |
| `ADMIN_MAX_FAILED_LOGINS` | Admin lockout threshold — see E005 | no | `5` | no |
| `ADMIN_LOCKOUT_SECONDS` | Admin lockout window — see E005 | no | `900` | no |

¹ Required only to unlock signing in deployments that issue licenses; when unset the signer stays locked
(readiness reports the signer as down) but the rest of the API runs.

## Secrets: the `<VAR>_FILE` convention (DDR-005)

Secrets MUST be provided as **mounted files**, never baked into the image or passed only through plain
env (which leaks via `docker inspect` and logs). For any secret `NAME`, set `NAME_FILE` to the path of a
mounted file whose contents are the value:

- `DATABASE_URL_FILE=/run/secrets/database_url`
- `API_KEY_SECRET_FILE=/run/secrets/api_key_secret`
- `SIGNING_CUSTODIAN_SHARES_FILE=/run/secrets/signing_custodian_shares`

Resolution rules:

- `NAME_FILE` takes precedence over a direct `NAME`.
- The file's contents are read and a single trailing newline is trimmed.
- An empty or unreadable file for a **required** secret is treated as missing → fail-fast naming it.

### Hygiene

- Do not put secrets in `ENV`/build args — they persist in image layers and `docker inspect`.
- Mount secrets read-only (Docker/compose secrets land at `/run/secrets/<name>`; SOPS+age, Sealed
  Secrets, or Vault are all supported — the image is agnostic to the mechanism).
- Rotate the DB credential and `API_KEY_SECRET` per policy; rotate signing keys via the E004 keyring.
- Startup logging summarizes effective configuration with the DB password redacted and the API-key
  secret masked — no secret value is ever logged.
