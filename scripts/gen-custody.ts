// Dev-only: generate Shamir custodian shares to UNLOCK the signer for a local demo.
// The keystore master key is a random 32 bytes, split k-of-n (here 3 shares, threshold 2) via the
// project's own `shamirSplit`. The API unlocks by reconstructing the master from >= 2 base64 shares
// in `SIGNING_CUSTODIAN_SHARES`. We write exactly the two the API needs to `secrets/custodian_shares`
// and print the third as an offline backup.
//
// IMPORTANT: once a product signing key is provisioned it is envelope-encrypted UNDER this master and
// stored in the DB. Regenerating the master would orphan that key (issuance breaks). So this script
// refuses to overwrite an existing shares file — generate ONCE and keep it stable.
//
// NOT FOR PRODUCTION: a real deployment splits the shares across separate custodians/hosts; bundling
// the threshold in one file defeats k-of-n.
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { shamirSplit } from "../src/server/modules/signing/custody.js";

const OUT = resolve(process.cwd(), "secrets", "custodian_shares");

if (existsSync(OUT)) {
  // eslint-disable-next-line no-console
  console.log(`✓ ${OUT} already exists — keeping it (regenerating would orphan any provisioned signing key).`);
  process.exit(0);
}

const N = 3;
const K = 2;
const master = crypto.randomBytes(32);
const shares = shamirSplit(master, N, K).map((s) => s.toString("base64"));

// The API needs the threshold (K) shares, comma-separated.
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, shares.slice(0, K).join(","), { mode: 0o600 });

// eslint-disable-next-line no-console
console.log(
  [
    "",
    `✓ Wrote ${K}-of-${N} custodian shares to ${OUT} (mounted into the api container).`,
    `  offline backup share (not written): ${shares[N - 1]}`,
    "",
    "Next: ensure docker-compose.override.yml mounts it, then:",
    "  docker compose up -d --force-recreate api",
    "  curl -fsS localhost:8080/internal/ready/signing",
    "",
  ].join("\n"),
);
