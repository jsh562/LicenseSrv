// Copy the prebuilt wasm-pack signer package into dist/ (build step, all platforms).
//
// WHY THIS EXISTS: `src/server/modules/signing/token.ts` loads the signer with
//   createRequire(import.meta.url)("../../../bindings/wasm/pkg/licensesrv.js")
// which, from the COMPILED location `dist/server/modules/signing/token.js`, resolves to
// `dist/bindings/wasm/pkg`. That package is prebuilt JS + a .wasm binary, not TypeScript, so `tsc` never
// emits it — a plain `tsc -p tsconfig.json` produces a dist/ that CANNOT load the signer, and the failure
// only surfaces at runtime as `503 signer_unavailable` from POST /admin/licenses.
//
// The Dockerfile handles this with its own `COPY --from=build ... ./dist/bindings/wasm/pkg` line. This
// script is the equivalent for non-Docker builds (see `npm run build:native`), written in Node rather than
// as a shell `cp` / `xcopy` so one implementation serves Windows, Linux, and macOS.
import { cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(repoRoot, "src/bindings/wasm/pkg");
const dest = resolve(repoRoot, "dist/bindings/wasm/pkg");

if (!existsSync(src)) {
  // Fail loudly: silently producing a signer-less dist/ is the exact failure mode this script prevents.
  console.error(
    `✗ wasm package not found at ${src}\n` +
      `  The signer cannot load without it. It is normally committed to the repo; if it is missing, ` +
      `rebuild it with: bash scripts/build-wasm-web.sh`,
  );
  process.exit(1);
}

// `recursive` copies the directory tree; wasm-pack output is a flat set of .js/.d.ts/.wasm files.
cpSync(src, dest, { recursive: true });
console.log(`✓ wasm signer package -> ${dest}`);
