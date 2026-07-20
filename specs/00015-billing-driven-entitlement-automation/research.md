# Research — E014 Billing-driven Entitlement Automation

Best practices for automating license lifecycle from an external billing provider's signed webhooks. Multi-tenant, self-hostable Node/TS/Fastify/Postgres. Payment processing is permanently OUT OF SCOPE — the server only reacts to events. Suspension/revocation propagates to clients via E013.

## Webhook signature verification
Verify the HMAC signature over the RAW request body BEFORE any parsing/processing; reject invalid with 4xx and never enqueue. Signatures include a timestamp (Stripe-Signature `t=…,v1=…` style); enforce a recency tolerance (default ~5 min) to bound replay. Store the signing secret PER tenant/connection (each provider connection its own secret); support rotation. Avoid: hand-rolled HMAC, zero tolerance, verifying after body mutation (Fastify must expose the raw body), a single global secret across tenants.
Sources: docs.stripe.com/webhooks; webhooks.fyi/security/replay-prevention.

## Idempotent webhook processing
Dedupe on the provider event id (e.g. `evt_…`) as the idempotency key; UPSERT it into a processed-events table INSIDE the same transaction as the side effect, so at-least-once delivery applies exactly-once. Ack fast (200/202) then process; keep the dedup record longer than the provider retry window (48h+). Avoid: marking processed after the side effect (crash → double-apply), TTLs shorter than the retry window, dedup by payload hash instead of event id.
Sources: hookdeck.com idempotency guide; svix.com idempotency-and-deduplication.

## Subscription lifecycle → entitlement mapping
Grant/revoke on webhook-confirmed subscription state, not on checkout success. Map: created/active/invoice-paid → provision or extend; past_due → enter grace (stay usable); canceled/unpaid → SUSPEND (not terminal revoke — keep recovery possible); refund/chargeback → revoke per policy (terminal). Persist an explicit subscription↔license link (subscription id on the license) so every event resolves to exactly one license. Avoid: instant lockout on `past_due`, mapping `canceled` straight to terminal revoke, unlinked events with no license target.
Sources: docs.stripe.com/billing/subscriptions/webhooks; .../subscriptions/overview.

## Grace periods / dunning
On payment-failure/cancel, hold the license USABLE through a configurable grace window (per-tenant/plan; provider dunning is typically ~2 weeks) before auto-suspend. Recover automatically on a later payment-success/reactivation event, clearing grace and restoring active. Emit lifecycle timestamps (grace_started, grace_expires) so E013 enforcement + reconciliation can act. Avoid: immediate suspend on first failure, non-configurable durations, one-way grace ignoring a later payment, coupling grace expiry SOLELY to webhook arrival (also drive it from a scheduled job).
Sources: docs.stripe.com/billing/revenue-recovery/smart-retries; stripe.com dunning guide.

## Out-of-order / missed events & reconciliation
Treat delivery as unordered and lossy. Guard state transitions with the event's own timestamp/version: ignore an event older than the license's last-applied event time (never let a stale `active` overwrite a newer `canceled`). Run a periodic reconciliation job that pulls authoritative subscription state from the provider API and self-heals drift/missed events. Use UPSERT, not blind INSERT. Avoid: assuming ordered delivery, applying without a recency check, relying on webhooks alone with no polling safety net.
Sources: hookdeck.com webhook-ordering; docs.stripe.com/billing/subscriptions/webhooks.

## Provider-agnostic abstraction & security posture
Normalize each provider (Stripe/Paddle/…) at ingest into ONE internal canonical event model (type, subscription id, tenant, occurred-at, provider event id); keep provider-specific parsing in thin adapters. Decouple receipt from processing (durable store/queue). Route post-ack processing failures / unmapped event types to a dead-letter store for replay. Persist ONLY billing-lifecycle metadata — no card/PAN/PII — to stay outside PCI scope. Avoid: provider quirks leaking into core logic, storing card data or raw PII, dead-lettering signature/schema failures (reject inline instead).
Sources: hookdeck.com/blog/webhooks-at-scale; docs.stripe.com/webhooks.

## Summary
Verify-then-dedupe-then-apply is the backbone: verify raw-body HMAC + timestamp before processing, dedupe on provider event id with a transactional processed-events record, then map webhook-confirmed subscription state to license actions. Favour grace-before-lockout with auto-recovery, guard every transition against stale/out-of-order events, and back webhooks with periodic provider reconciliation. Normalize providers behind an adapter into one internal event model, dead-letter unmapped/failed events, and store zero card data (PCI-out-of-scope).

## E008/E013 integration grounding
E008 `license.status ∈ {active, suspended, revoked}` (revoked terminal); transitions suspend/reinstate/revoke are the mechanisms E014 drives (all audited). E008 has NO grace state — E014 adds a billing/grace OVERLAY (subscription↔license link + billing_state + grace_expires) and drives `active↔suspended` via the E008 lifecycle; `canceled`→grace→suspend, refund→revoke. Suspension/revocation then propagates to connected clients via E013 (online validate/heartbeat non-reissue + CRL). Issuance reuses E008 for provisioning.
