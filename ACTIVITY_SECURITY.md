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

It does **not** persist raw Jellyfin device IDs.

The live remote network endpoint is encrypted using the existing AES-256-GCM data-encryption layer. Normal worker logs contain counts and health summaries, not usernames, media titles, addresses, passwords, provider tokens or API keys.

Playback and policy records have configurable retention periods. The initial defaults are:

- playback history: 90 days
- policy events: 365 days

Longer retention should be a deliberate operator choice.

## Process isolation

The activity worker is a separate container/process. It requires only:

- PostgreSQL access
- `DATA_ENCRYPTION_KEY`, so it can decrypt Jellyfin API keys already stored in PostgreSQL
- playback-policy configuration

It does not need Stripe, PayPal, web-session, SMTP, Telegram or WhatsApp credentials. The Compose service has no published network port, runs with a read-only filesystem, uses `no-new-privileges`, and drops Linux capabilities.

## Rollout procedure

1. Deploy the migration and worker with `STREAM_POLICY_MODE=observe`.
2. Leave it in observation mode through representative peak usage.
3. Review `stream_policy_events` for false positives, stale sessions, paused-client behaviour and server/API failures.
4. Confirm the configured plan stream limits are correct for every live plan.
5. Confirm all managed Jellyfin accounts are mapped to the correct platform customer.
6. Only then consider enforcement.
7. Enable enforcement in a low-risk window and watch policy events closely.
8. If any unexpected behaviour occurs, return `STREAM_POLICY_MODE` to `observe`; no database rollback is required.

## API basis

The worker uses Jellyfin's authenticated session API to retrieve recently active sessions. When enforcement is explicitly enabled, it uses Jellyfin's playstate `Stop` command for the confirmed excess session. No client or server credentials are exposed to the browser.

## Future hardening

Before broad production cutover, add:

- privileged admin review UI for encrypted endpoint data
- security-event notifications
- automated tests with mocked multi-server Jellyfin sessions and race conditions
- configurable policy exceptions with expiry dates and audit trails
- privacy export/deletion workflows for customer activity history
- download-policy instrumentation at the reverse-proxy or Jellyfin event layer
