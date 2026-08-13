# Phase 3 — Customer billing and Jellyfin provisioning

This phase adds the first end-to-end direct-customer path required to replace Streams Manager while preserving the existing Steam Fusion admin/reseller interface.

## Implemented

- Separate customer/site identity backed by PostgreSQL
- Customer registration and login
- Optional email-verification token support
- Customer account dashboard
- Database-backed visible plans
- One-use 24-hour free trial
- Multiple Jellyfin server selection by class, health, capacity and priority
- Automatic Jellyfin account creation
- Plan-to-Jellyfin policy reconciliation for downloads, transcoding and Live TV
- Expiry/cancellation disable and renewal/reactivation reconciliation
- Periodic retry of active entitlements after transient Jellyfin failures
- Periodic Jellyfin server health checks
- Customer-managed Jellyfin password changes without storing the password
- Stripe Checkout for one-time or recurring products
- Stripe Billing Customer Portal
- Stripe signed/idempotent webhook processing
- PayPal Orders for fixed-duration purchases
- PayPal Subscriptions for recurring products
- PayPal webhook signature verification and idempotent processing
- Retryable failed payment webhooks
- Provider-neutral internal subscription state remains the source of truth
- CLI helpers to register Jellyfin servers and map payment-provider products/prices
- CI with PostgreSQL migrations, schema checks, customer registration/login smoke test and dependency audit

## Not yet enabled automatically

Payment buttons only appear after the corresponding plan/provider mapping exists. Live provider credentials are deliberately not committed.

Email verification should remain disabled until the notification/email phase connects a mail delivery provider.

## Configure a Jellyfin server

```bash
npm run server:add -- \
  "Premium Jellyfin" premium premium \
  "http://jellyfin:8096" "https://premium.example.com" \
  "YOUR_JELLYFIN_API_KEY" 500
```

The API key is encrypted before it is written to PostgreSQL.

## Map payment products/prices

Stripe example:

```bash
npm run payments:map -- stripe monthly price_xxx subscription
npm run payments:map -- stripe six-month price_xxx payment
npm run payments:map -- stripe yearly price_xxx payment
```

PayPal example:

```bash
npm run payments:map -- paypal monthly P-PAYPALPLAN subscription
npm run payments:map -- paypal six-month PAYPAL_EXTERNAL_ID payment
npm run payments:map -- paypal yearly PAYPAL_EXTERNAL_ID payment
```

For PayPal one-time products the external ID is retained as configuration metadata while the order amount is generated from the internal plan price. For recurring products it must be the PayPal Billing Plan ID.

## Webhooks

- Stripe: `POST /webhooks/stripe`
- PayPal: `POST /webhooks/paypal`

Both routes verify provider signatures before changing subscription state. Successfully processed provider event IDs are idempotent; failed events remain retryable.

## Customer routes

- `/account/register`
- `/account/login`
- `/account`

The customer account portal is intentionally separate from `/login`, which remains the legacy admin/reseller login during the transition.

## Important remaining enforcement work

The plan `streams` value is stored and surfaced, but concurrent-stream enforcement is a separate monitor. Jellyfin user policy does not provide a dependable native per-user concurrent-stream cap, so the next enforcement phase will monitor active sessions and terminate sessions that exceed the subscribed allowance.
