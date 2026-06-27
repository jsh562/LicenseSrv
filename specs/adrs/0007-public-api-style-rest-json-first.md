---
adr_id: ADR-0007
status: accepted
date: 2026-06-26
tags: [api, rest, openapi, grpc, integration]
supersedes: []
superseded_by: ""
related_artifacts: [specs/00001-license-server/plan.md, specs/00001-license-server/spec.md]
---

# ADR-0007: Public API Style — REST/JSON First

## Status

Accepted.

## Context

The license server must expose runtime capabilities (activate, validate, deactivate, entitlements, air-gap) and admin capabilities (catalog, issuance, lifecycle) to clients written in any language and integrated into any stack, ideally without a vendor SDK. We must choose a public API style that maximizes reach and integration speed now, supports tooling and webhooks, and enables fast SDK generation, while leaving room for a high-throughput transport on a future ingestion path. Offline verification is the hot path and is handled by the embeddable verifier with no server call, so the public API does not carry the highest-volume traffic.

## Decision Drivers

- Broadest client and language compatibility — integrate into any stack.
- Zero-SDK reachability via plain HTTPS.
- Webhook and general tooling friendliness.
- Fastest SDK and client generation from a published contract.
- Room for a high-throughput transport later without reworking the primary surface.

## Considered Options

### Option A: REST/JSON first (OpenAPI contract)

- **Pros**: Universally reachable from any language and from cURL with no SDK; ubiquitous tooling, gateways, and webhook compatibility; OpenAPI drives fast, multi-language SDK codegen and serves as the contract source of truth; gRPC can be added later for throughput-critical paths.
- **Cons**: Less efficient than binary RPC for very high-volume streaming — acceptable here because offline verify needs no server call.

### Option B: gRPC-first

- **Pros**: Efficient binary transport, streaming, and strong typed contracts.
- **Cons**: Browser and cross-language reach require extra tooling (grpc-web/proxies); harder zero-SDK integration; weaker fit for webhooks and ad hoc tooling; raises the integration bar for "any stack" clients.

### Option C: GraphQL

- **Pros**: Flexible client-driven queries; single endpoint.
- **Cons**: Overkill for command-style runtime operations (activate/validate/deactivate); caching, rate-limiting, and webhook patterns are more awkward; smaller universal-tooling footprint than REST; steeper client learning curve.

## Decision Outcome

Chosen option: **REST/JSON first** — expose runtime and admin capabilities as REST/JSON over HTTPS, described by OpenAPI as the contract source of truth from which SDKs are generated. gRPC is deferred and reserved for a later throughput-critical internal/ingestion path (e.g., metering ingestion), not the primary public surface.

## Consequences

### Positive

- Universal reach and the simplest possible integration from any language or stack, with no SDK required.
- OpenAPI gives a single source of truth for SDK and client code generation, plus broad gateway/webhook tooling.
- A later gRPC ingestion path can be introduced without changing the REST surface.

### Negative

- REST/JSON is less efficient for very high-volume streaming than a binary RPC transport.

### Neutral

- The high-volume hot path is offline verification, which makes no server call, so the REST surface is not the throughput bottleneck.

## Links

- ADR-0001 (token format consumed by activate/validate/entitlements endpoints)
- ADR-0002 (embeddable verifier performs offline verify with no API call)
- ADR-0005 (modular monolith service exposing this API)
- project-instructions.md — Technology Stack; integration and interoperability principles
- specs/00001-license-server/plan.md
