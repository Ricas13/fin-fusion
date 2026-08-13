# Streams Manager Replacement Target

Steam Fusion is being expanded from a reseller panel into a unified Jellyfin commerce and account platform.

## Goal

One control plane should manage both direct customers and reseller-managed customers:

1. Customer selects a plan or a reseller allocates a plan.
2. Subscription state is stored in Steam Fusion/PostgreSQL.
3. A Jellyfin server is selected by plan/server class and availability.
4. Jellyfin account policy is derived from the plan.
5. Payment providers update the subscription through verified webhooks.
6. Subscription status changes enable, disable or migrate Jellyfin access.

## Direct plans

The initial seed mirrors the current CAPTAiNFiN commercial structure:

| Plan | Price | Streams | Downloads | Video transcoding |
| --- | ---: | ---: | --- | --- |
| 24-hour trial | $0 | 1 | No | No |
| Monthly | $6 | 3 | Yes | No |
| 6 months | $30 | 3 | Yes | No |
| Yearly | $50 | 3 | Yes | No |

Plans are database records rather than hard-coded UI values so pricing and permissions can evolve independently.

## Stripe design

Use Stripe Billing + Checkout Sessions for recurring direct subscriptions. Do not implement renewal with raw PaymentIntents.

- Products/Prices map to internal `plans`.
- Checkout creates or links an internal customer.
- Verified webhook events are recorded idempotently in `payment_events` before processing.
- Stripe customer/subscription IDs are stored on the internal subscription record.
- Customer Portal can be used initially for billing self-service while the native account UI is developed.
- Use a restricted API key where possible.
- Tax is intentionally not enabled automatically; tax registrations must be configured before Stripe Tax is switched on.

## PayPal design

PayPal is treated as a second payment adapter, not a separate subscription system.

- PayPal plan/product IDs map to internal `plans`.
- Webhooks are verified and persisted idempotently in `payment_events`.
- Provider subscription state is translated into the same internal subscription states used by Stripe.

## Why the provider-neutral model matters

Jellyfin provisioning must never depend directly on a Stripe or PayPal object. It depends on the internal subscription state. This allows:

- Stripe and PayPal side by side;
- manual/admin subscriptions;
- reseller-credit subscriptions;
- future payment-provider changes;
- migration from Streams Manager without recreating Jellyfin accounts.

## Streams Manager migration sequence

1. Export or query existing customers/subscriptions from Streams Manager.
2. Match them to Jellyfin users.
3. Import customer and plan state into PostgreSQL.
4. Preserve existing Jellyfin IDs and usernames.
5. For Stripe/PayPal customers, link provider customer/subscription IDs without charging again.
6. Run both systems in reconciliation-only mode for a short transition period.
7. Disable subscription writes in Streams Manager.
8. Make Steam Fusion authoritative for provisioning and expiry.
9. Retire Streams Manager after reconciliation is clean.

## Features required before replacement

- PostgreSQL authoritative datastore
- durable sessions
- multi-Jellyfin support
- plan-to-Jellyfin policy engine
- direct customer login/account area
- Stripe Checkout/Billing + webhook processing
- PayPal subscriptions + webhook processing
- password reset/account recovery
- TOTP 2FA for admin/resellers
- expiry/dunning state machine
- notification service
- import/reconciliation tooling
- admin audit log
- tested backup/restore procedure

## Non-goal

Do not cut over from Streams Manager until subscription reconciliation, expiry behavior and payment webhooks have been tested against a staging Jellyfin server.
