# Private staging rollout

This project must move through private staging before any public CAPTaINFiN customer traffic is routed to it.

## Merge boundary

After the native Users + Servers administration phase is reviewed and green, stop stacking infrastructure changes and consolidate the existing draft PR chain into `main` in dependency order. Do not expose the application publicly during the merge process.

Before staging, confirm the resulting `main` branch passes the full CI workflow from a clean checkout.

## Staging isolation

The first deployment is administration-only/private. It must not be linked from the public CAPTaINFiN site and must not receive production Stripe or PayPal webhooks.

Use HTTPS through the normal reverse proxy and restrict access with a private network/VPN, firewall allowlist, or an additional reverse-proxy authentication layer. PostgreSQL must not publish a public port.

Keep stream enforcement in observation mode throughout staging.

## Required production-style configuration

Generate independent random values for every encryption/session purpose. Never reuse one key for another purpose.

Configure the PostgreSQL application account and the separate least-privilege activity-worker database account.

Configure `JELLYFIN_ALLOWED_HOSTS` as an exact comma-separated list of Jellyfin hostnames that the administration UI may use as internal/base URLs. For example:

```text
JELLYFIN_ALLOWED_HOSTS=jellyfin,premium-jellyfin,10.20.0.15
```

Only include infrastructure controlled by the deployment. The application intentionally refuses production server URL changes when this allowlist is absent.

Do not enable live Stripe/PayPal credentials for the first staging boot.

## First staging boot

1. Start PostgreSQL only and verify its persistent volume and backup destination.
2. Run all database migrations.
3. Import legacy JSON data into PostgreSQL using a backup copy of the source data.
4. Run the staff-auth migration so legacy admin/reseller numeric IDs are mapped to PostgreSQL identities.
5. Start the web application privately.
6. Complete administrator TOTP enrollment using the independent enrollment approval value.
7. Save the one-time recovery codes outside the server.
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
- manual reconciliation requires a fresh second factor and changes only Jellyfin entitlement state;
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

Streams Manager remains the production customer system while this application is staged. Before replacement, import or mirror representative customer/subscription state and compare:

- entitlement status;
- expiry dates;
- server assignment;
- stream/download/transcode policy;
- payment state;
- customer portal state;
- notification decisions;
- activity/enforcement decisions.

Do not allow both systems to independently mutate the same production entitlement unless the operation has been explicitly designed for dual-running.

## Backup/restore gate

Before public launch:

- create an encrypted PostgreSQL backup;
- restore it into a separate database/container;
- verify administrator login/2FA state, customers, subscriptions, servers, encrypted Jellyfin credentials, payment mappings, and audit records after restore;
- document the rollback procedure to the existing Streams Manager deployment.

A backup that has not been restored successfully is not considered a tested backup.

## Public cutover gate

Public CAPTaINFiN traffic may move only after all of these are true:

- the complete merged `main` branch is green;
- private staging has passed real Jellyfin provisioning and expiry/reactivation tests;
- administrator 2FA and session controls are confirmed;
- server URL allowlisting and least-privilege worker DB access are confirmed;
- Stripe test mode and PayPal sandbox flows are confirmed if those gateways will be used;
- backup + restore has been demonstrated;
- Streams Manager shadow comparisons show no material entitlement drift;
- a rollback plan is available;
- stream enforcement remains observe-only until its production observations are reviewed separately.

The first public release should be a controlled migration, not an immediate all-customer switch.
