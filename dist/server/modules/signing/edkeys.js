// Ed25519 key helpers over `node:crypto` (TR-002/TR-003). The private key is handled only as a raw
// 32-byte seed inside the custody boundary; these helpers convert to/from node KeyObjects for
// signing. No private material is logged or returned by the module beyond the custody boundary.
import crypto from "node:crypto";
// PKCS8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** Generate a per-product Ed25519 keypair with a unique `key_id` (TR-003). */
export function generateSigningKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const rawSeed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
    const keyId = "k-" + crypto.randomBytes(8).toString("hex");
    return { keyId, publicKey: Buffer.from(rawPub), privateSeed: Buffer.from(rawSeed) };
}
/** Build the node private KeyObject from a raw 32-byte seed (custody boundary only). */
export function privateKeyFromSeed(seed) {
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}
/** Sign `message` with the raw seed's Ed25519 key (deterministic, RFC 8032). Returns 64 bytes. */
export function ed25519Sign(seed, message) {
    return crypto.sign(null, message, privateKeyFromSeed(seed));
}
