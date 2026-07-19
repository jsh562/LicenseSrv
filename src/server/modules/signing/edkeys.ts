// Ed25519 key helpers over `node:crypto` (TR-002/TR-003). The private key is handled only as a raw
// 32-byte seed inside the custody boundary; these helpers convert to/from node KeyObjects for
// signing. No private material is logged or returned by the module beyond the custody boundary.
import crypto from "node:crypto";

// PKCS8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// SPKI DER prefix for an Ed25519 public key; the 32-byte raw public key follows.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A freshly generated Ed25519 keypair: a stable `keyId`, the raw 32-byte public key + private seed. */
export interface GeneratedKey {
  keyId: string;
  publicKey: Buffer; // 32 raw bytes
  privateSeed: Buffer; // 32 raw bytes (custody-only)
}

/** Generate a per-product Ed25519 keypair with a unique `key_id` (TR-003). */
export function generateSigningKey(): GeneratedKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const rawSeed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const keyId = "k-" + crypto.randomBytes(8).toString("hex");
  return { keyId, publicKey: Buffer.from(rawPub), privateSeed: Buffer.from(rawSeed) };
}

/** Build the node private KeyObject from a raw 32-byte seed (custody boundary only). */
export function privateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Build the node public KeyObject from a raw 32-byte Ed25519 public key (public material only). */
export function publicKeyFromRaw(raw: Uint8Array): crypto.KeyObject {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Sign `message` with the raw seed's Ed25519 key (deterministic, RFC 8032). Returns 64 bytes. */
export function ed25519Sign(seed: Buffer, message: Buffer): Buffer {
  return crypto.sign(null, message, privateKeyFromSeed(seed));
}

/** Verify a 64-byte Ed25519 `signature` over `message` against a raw 32-byte public key. */
export function ed25519Verify(publicKey: Uint8Array, message: Buffer, signature: Buffer): boolean {
  return crypto.verify(null, message, publicKeyFromRaw(publicKey), signature);
}
