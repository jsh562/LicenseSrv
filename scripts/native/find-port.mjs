// Resolve a usable TCP port for the native (no-Docker) path.
//
// Usage:  node scripts/native/find-port.mjs <preferred> [host] [maxTries]
// Prints the chosen port to stdout (nothing else, so shells can capture it directly):
//     PORT=$(node scripts/native/find-port.mjs 8080)
//
// A port counts as free only when BOTH checks pass. Neither is sufficient alone, and this was verified
// empirically against a running Docker container rather than assumed:
//
//  1. CONNECT probe — is anything already answering there?
//     Necessary because of Windows socket semantics. Windows permits a duplicate bind unless the original
//     owner set SO_EXCLUSIVEADDRUSE, and Node's `exclusive: true` does NOT set that flag (it only governs
//     cluster port sharing). Measured case: Docker Desktop published a container on 0.0.0.0:8080 and
//     netstat showed it LISTENING, yet a fresh process could still bind both 127.0.0.1:8080 and
//     0.0.0.0:8080 successfully. A bind-only check therefore reports 8080 "free" on Windows and the native
//     server then collides with the container. A connect probe catches exactly this.
//
//  2. BIND probe — could WE actually bind it?
//     Necessary because a connect probe only proves nobody is *accepting*. It misses ports that are
//     reserved by the OS, blocked by permissions (EACCES on privileged ports), or held by a socket that is
//     bound but not accepting. Asking the kernel to bind is the authoritative answer to the question we
//     actually care about.
//
// HOST: probe the same host the server will bind (127.0.0.1 by default). A listener on 0.0.0.0 answers on
// loopback, so the connect probe still detects a container published on all interfaces.
//
// Only the native scripts use this. The server binary deliberately does NOT auto-relocate: in a container
// the port is intentional (compose publishes 8080:8080 and the healthcheck probes 127.0.0.1:8080), so a
// conflict there must fail loudly rather than silently move and break the healthcheck.
import { createServer, connect } from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_TRIES = 20;
const CONNECT_TIMEOUT_MS = 600;

/** True when something is already accepting connections on host:port. */
export function hasListener(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    // ECONNREFUSED is the healthy "nothing there" signal. Any other error (EHOSTUNREACH, …) also means we
    // could not reach a listener, so treat it as absent and let the bind probe make the final call.
    socket.once("error", () => done(false));
    // A port that accepts the TCP handshake but stalls is still occupied — assume taken rather than
    // collide. Skipping a usable port costs one increment; colliding costs a failed startup.
    socket.once("timeout", () => done(true));
  });
}

/** True when this process can actually bind host:port. */
export function canBind(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/** A port is usable only when nothing is listening AND we can bind it. See the header for why both. */
export async function isPortFree(port, host = DEFAULT_HOST) {
  if (await hasListener(port, host)) return false;
  return canBind(port, host);
}

/**
 * Return `preferred` when usable, otherwise the first usable port scanning upward.
 * Throws after `maxTries` rather than looping forever — an exhausted range means something is badly wrong
 * (a whole block reserved, or a permissions problem), and hanging would hide that.
 */
export async function findPort(preferred, host = DEFAULT_HOST, maxTries = DEFAULT_MAX_TRIES) {
  for (let offset = 0; offset < maxTries; offset++) {
    const candidate = preferred + offset;
    // Ports are 16-bit; walking past the ceiling is a configuration error, not something to wrap around.
    if (candidate > 65535) break;
    if (await isPortFree(candidate, host)) return candidate;
  }
  throw new Error(
    `no free port found in ${preferred}..${Math.min(preferred + maxTries - 1, 65535)} on ${host}`,
  );
}

// CLI mode. Guarded so importing this module from a test or another script has no side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const preferred = Number(process.argv[2]);
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    console.error("✗ usage: node scripts/native/find-port.mjs <preferred 1-65535> [host] [maxTries]");
    process.exit(2);
  }
  const host = process.argv[3] || DEFAULT_HOST;
  const maxTries = Number(process.argv[4]) || DEFAULT_MAX_TRIES;
  try {
    // stdout carries ONLY the port so callers can capture it; diagnostics go to stderr.
    process.stdout.write(String(await findPort(preferred, host, maxTries)));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
