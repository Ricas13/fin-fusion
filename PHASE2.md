# Phase 2 — PostgreSQL, Multi-Server and Subscription Foundation

This phase establishes the durable platform layer required before adding direct billing and replacing Streams Manager.

## Included

- PostgreSQL schema for admins, resellers, customers, Jellyfin accounts, servers, plans, subscriptions, payment events, content requests and audit events.
- PostgreSQL-backed persistent web sessions.
- AES-256-GCM encryption helper for Jellyfin API keys and future TOTP/payment secrets.
- Multi-Jellyfin registry with server classes, priorities and health state.
- Transaction-safe reseller credit and subscription mutation service.
- Provider-neutral Stripe/PayPal event model with idempotency keys.
- Migration runner and legacy JSON importer.
- Production Dockerfile and PostgreSQL Docker Compose stack.
- Streams Manager replacement architecture and cutover plan.

## Deliberately not enabled yet

The existing reseller UI still runs through the legacy route layer. The PostgreSQL platform layer is introduced beside it so migration can be tested before it becomes authoritative.

Phase 3 will make plans/subscriptions authoritative for Jellyfin provisioning and introduce the direct-customer account/API path.
