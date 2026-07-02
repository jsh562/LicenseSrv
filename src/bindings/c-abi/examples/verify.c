/*
 * Reference C integration for the embeddable verifier (US1, FR-009, FR-018).
 *
 * Links the cdylib + generated header and verifies a LIC1 license **fully offline** — no network,
 * no Rust toolchain, no cryptography in C. Reads the inputs from argv so the same sample serves
 * the quickstart and the automated integration test:
 *
 *   verify <token> <key_id> <hex_pubkey(64)> <now_unix> <entitlement>
 *
 * Prints the ABI version, the reason code, and (on success) the requested entitlement, the
 * `seats` limit, and the anchor to persist. Exit code: 0 = valid, 1 = rejected, >=3 = usage/setup.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "licensesrv.h"

/* Decode `out_len` hex bytes; returns 0 on success, -1 on malformed input. */
static int hex2bin(const char *hex, uint8_t *out, size_t out_len) {
    if (strlen(hex) != out_len * 2) {
        return -1;
    }
    for (size_t i = 0; i < out_len; i++) {
        unsigned int byte;
        if (sscanf(hex + i * 2, "%2x", &byte) != 1) {
            return -1;
        }
        out[i] = (uint8_t)byte;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 6) {
        fprintf(stderr, "usage: %s <token> <key_id> <hex_pubkey> <now_unix> <entitlement>\n", argv[0]);
        return 3;
    }
    const char *token = argv[1];
    const char *key_id = argv[2];
    const char *hex_pk = argv[3];
    long long now = atoll(argv[4]);
    const char *entitlement = argv[5];

    uint8_t public_key[32];
    if (hex2bin(hex_pk, public_key, 32) != 0) {
        fprintf(stderr, "bad hex public key\n");
        return 3;
    }

    printf("abi=%u\n", ls_abi_version());

    /* Build the trusted keyring (FR-007). */
    LsKeyring *keyring = ls_keyring_new();
    if (keyring == NULL) {
        fprintf(stderr, "keyring allocation failed\n");
        return 4;
    }
    uint32_t added = ls_keyring_add(keyring, key_id, public_key);
    if (added != OK) {
        fprintf(stderr, "ls_keyring_add failed: %u\n", added);
        ls_keyring_free(keyring);
        return 5;
    }

    /* Verify offline: no anchor, no fingerprint in this sample. */
    LsResult *result = ls_verify(keyring, token, (int64_t)now, NULL, NULL, 0);
    if (result == NULL) {
        fprintf(stderr, "verify allocation failed\n");
        ls_keyring_free(keyring);
        return 4;
    }

    uint32_t code = ls_result_code(result);
    printf("code=%u\n", code);

    if (code == OK) {
        printf("%s=%d\n", entitlement, ls_result_has(result, entitlement) ? 1 : 0);

        int64_t limit = 0;
        if (ls_result_limit(result, "seats", &limit)) {
            printf("seats=%lld\n", (long long)limit);
        } else {
            printf("seats=-\n");
        }

        int64_t anchor = 0;
        if (ls_result_next_anchor(result, &anchor)) {
            printf("anchor=%lld\n", (long long)anchor);
        }
    }

    /* Free each handle exactly once (FR-008). */
    ls_result_free(result);
    ls_keyring_free(keyring);

    return code == OK ? 0 : 1;
}
