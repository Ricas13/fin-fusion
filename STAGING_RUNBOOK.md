# Private staging rollout

This project must move through private staging before any public CAPTAiNFiN customer traffic is routed to it.

## Merge boundary

Stage a reviewed `main` build rather than stacking deployment-only changes on the production host. Before staging, confirm the resulting `main` branch passes the full CI workflow from a clean checkout.

Do not expose the application publicly while repository or database changes are still being reconciled.

## Staging isolation

The first deployment is administration-only/private. It must not be linked from the public CAPTAiNFiN site and must not receive production Stripe or PayPal webhooks.

Use HTTPS through the normal reverse proxy and restrict access with a private network/VPN, firewall allowlist, or an additional reverse-proxy authentication layer. PostgreSQL must not publish a public port.

Keep stream enforcement in observation mode throughout staging.

## Required production-style configuration

Generate independent random values for every encryption/session purpose. Never reuse one key for another purpose.

Use the normal deployment tooling so the web app and workers receive their separate least-privilege PostgreSQL identities.

Private/LAN integrations use the browser-managed outbound destination policy, not the retired `JELLYFIN_ALLOWED_HOSTS` environment variable. After the first administrator is created, open **Settings → Security → Session & registration limits**, enable private integration access only when needed, and add the exact Jellyfin hostname and/or private CIDR that CAPTAiNFiN is allowed to reach. Metadata, link-local and reserved destinations remain blocked even when private integrations are enabled.

Do not enable live Stripe/PayPal credentials for the first staging boot.

## First staging boot

1. Start PostgreSQL only and verify its persistent volume and backup destination.
2. Run all database migrations and runtime-role bootstrap through the supported deployment path.
3. If migrating legacy data, import it from a backup copy and validate the resulting customer/subscription state.
4. Start the web application privately and complete first-run administrator setup.
5. Configure the canonical public URL and regional settings.
6. Configure private integration trust under **Settings → Security** before adding any private/LAN Jellyfin endpoint.
7. Enrol administrator TOTP from **My security** and save the one-time recovery codes outside the server if 2FA is part of the deployment policy. Normal TOTP enrolment does not require the legacy `ADMIN_2FA_ENROLLMENT_TOKEN` compatibility variable.
8. Verify `/admin/security`, `/admin/activity`, `/admin/users`, and `/admin/servers`.
9. Configure/register the real Jellyfin server through the native Servers screen and run a health check.
10. Start the activity worker with its restricted database account and keep stream policy in observation mode.

## Safe Jellyfin validation

Use test or explicitly selected accounts first. Verify all of the following before touching the wider customer base:

- a trial entitlement provisions the intended server and policy;
- a paid/manual entitlement provisions the intended server and policy;
- downloads/transcoding permissions match the selected plan;
- expiry disables access without deleting the Jellyfin account;
- renewal/reactivation restores access;
- manual reconciliation applies only the intended Jellyfin entitlement state;
- server API keys are never rendered back to the browser;
- server placement respects class, capacity, health, trial/paid eligibility, and drain state;
- activity monitoring records sessions without exposing protected network telemetry;
- the activity worker cannot read payment or authentication tables.

## Payment staging

Only after Jellyfin provisioning is stable:

1. enable Stripe test mode/restricted test key and test webhook secret;
2. enable PayPal sandbox credentials;
3. map staging provider price/product IDs to internal plans;
4. test successful purchase, renewal, cancellation, failed payment, duplicate/replayed webhook, and delayed webhook delivery;
5. confirm payment events change the internal subscription first and Jellyfin is reconciled from that state;
6. confirm no payment-provider event can delete a Jellyfin user.

Do not use live payment credentials until the above passes.

## Streams Manager shadow period

If an older customer-management system is still authoritative during migration, keep it as the production system while CAPTAiNFiN is staged. Before replacement, import or mirror representative customer/subscription state and compare:

- entitlement status;
- expiry dates;
- server assignment;
- stream/download/transcode policy;
- payment state;
- customer portal state;
- notification decisions;
- activity/enforcement decisions.

Do not allow two systems to independently mutate the same production entitlement unless the operation has been explicitly designed for dual-running.

## Backup/restore gate

Before public launch:

- create an encrypted PostgreSQL backup;
- restore/verify it through the supported recovery tooling;
- verify administrator login/2FA state, customers, subscriptions, servers, encrypted Jellyfin credentials, payment mappings, and audit records after restore;
- document the rollback procedure for the deployment being replaced.

A backup that has not been successfully verified/restored is not considered a tested backup.

## Public cutover gate

Public CAPTAiNFiN traffic may move only after all of these are true:

- the complete merged `main` branch is green;
- private staging has passed real Jellyfin provisioning and expiry/reactivation tests;
- administrator session controls and the chosen 2FA policy are confirmed;
- private integration trust contains only the required Jellyfin hosts/CIDRs and least-privilege worker DB access is confirmed;
- Stripe test mode and PayPal sandbox flows are confirmed if those gateways will be used;
- backup + restore verification has been demonstrated;
- any shadow-system comparisons show no material entitlement drift;
- a rollback plan is available;
- stream enforcement remains observe-only until its production observations are reviewed separately.

The first public release should be a controlled migration, not an immediate all-customer switch.
