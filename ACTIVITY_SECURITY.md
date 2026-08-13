# Playback Activity Security Model

The playback monitor is intentionally designed to fail safe. It must be deployed in observation mode before any concurrent-stream action is enabled.

## Default posture

- `STREAM_POLICY_MODE=observe` is the default.
- Setting only `STREAM_POLICY_MODE=enforce` is not sufficient to activate enforcement.
- Enforcement also requires the explicit acknowledgement value documented in `src/jellyfin/activity.js`.
- At least two consecutive over-limit observations are required.
- A newly observed playback receives a grace period before it can be considered for an action.
- The newest excess playback is selected first; established playbacks are preserved.
- Immediately before an action, the monitor re-queries every enabled Jellyfin server used by that customer.
- If any required server cannot be queried, the action is skipped.
- If the customer is no longer over the plan limit, the action is skipped.
- If the selected playback changed, disappeared, paused when paused sessions are excluded, or does not report media-control support, the action is skipped.
- PostgreSQL advisory locking prevents two worker instances from applying policy concurrently.

## Data minimisation

The monitor records only managed Jellyfin accounts that map to a customer in the platform database.

It does **not** persist raw Jellyfin device IDs. Remote endpoint data is encrypted and is not exposed in the standard customer or admin activity dashboards. Normal worker logs contain counts and health summaries rather than usernames, titles, addresses or credentials.

Playback and policy records have configurable retention periods. Initial defaults are 90 days for playback history and 365 days for policy events.

## Purpose-specific encryption

Operational secrets are separated by purpose:

- `JELLYFIN_ENCRYPTION_KEY` protects Jellyfin server API credentials.
- `ACTIVITY_ENCRYPTION_KEY` protects activity telemetry such as remote endpoints.
- `AUTH_ENCRYPTION_KEY` is reserved for authentication/2FA material and must never be given to the activity worker.
- `DATA_ENCRYPTION_KEY` remains only for legacy/general migration compatibility.

New Jellyfin credentials use the `jf1` envelope. Existing legacy values can be rotated with `npm run secrets:rotate-jellyfin`; legacy fallback is disabled unless explicitly enabled for migration.

## Database isolation

The activity worker uses `ACTIVITY_DATABASE_URL`, not the web application's database credential.

Run `npm run db:activity-role` after migrations to configure the `steamfusion_activity` role. Its privileges are deliberately narrow:

- column-level read access to only the Jellyfin server/account and subscription/plan fields needed for policy evaluation
- read/write access to activity, playback-history and policy-event tables
- no access to payment events, web sessions, reseller credits, content requests or authentication tables
- connection and query time limits to reduce resource-abuse blast radius

CI verifies that the worker role can perform its required activity write while a payment-table read is denied.

## Process isolation

The activity worker is a separate container with no published port. It runs with a read-only filesystem, `no-new-privileges`, and Linux capabilities dropped. Its environment contains only its restricted database connection, Jellyfin/activity encryption keys and playback-policy configuration; it does not receive payment, web-session or notification credentials.

## Admin dashboard

`/admin/activity` is read-only. It reuses the authenticated admin session, disables browser caching, records dashboard access in the audit log, and intentionally excludes encrypted remote endpoint values. Enforcement cannot be enabled from this page.

## Rollout procedure

1. Apply migrations.
2. Rotate any legacy Jellyfin server credentials to `JELLYFIN_ENCRYPTION_KEY`.
3. Configure the restricted activity database role.
4. Deploy the worker with `STREAM_POLICY_MODE=observe`.
5. Leave it in observation mode through representative peak usage.
6. Review stream-policy decisions, stale-session behaviour, paused-client behaviour and server/API failures.
7. Confirm plan stream limits and customer-to-Jellyfin account mappings.
8. Only then consider enforcement in a low-risk window.
9. If any unexpected behaviour occurs, return to observation mode; no database rollback is required.

## Future hardening

Before broad production cutover, add:

- security-event notifications
- mocked multi-server/race-condition tests
- temporary policy exceptions with expiry and audit trails
- privacy export/deletion workflows
- download-policy instrumentation
- administrator 2FA using the separate authentication encryption boundary
