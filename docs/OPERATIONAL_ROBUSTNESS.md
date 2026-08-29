# Operational robustness controls

This document covers three operational controls that intentionally do not change CAPTAiNFiN product behavior: request-service synchronization efficiency, worker-instance diagnostics, and payment-provider HTTP deadlines.

## Request-service / Seerr synchronization

`src/integrations/request-user-sync.js` reads the remote user state first, derives the plan-driven desired state, and compares managed fields before mutating Seerr. Permission writes and main-settings writes are skipped when the remote value already matches. Newly created users are still initialized as before.

Bulk synchronization uses a bounded worker pool. The default concurrency is **3** and `REQUEST_USER_SYNC_CONCURRENCY` may tune it, capped at **8**. Do not raise the cap to increase throughput without considering request-service rate limits and database connection pressure.

`syncAll()` and `syncSelected()` return the existing result counters plus `metrics` containing `usersInspected`, `unchanged`, `updated`, `failed`, `concurrency`, and `elapsedMs`. A failed user is recorded as failed and the remaining users continue through the bounded pool.

## Worker instance health

Migration `20260829174000_worker_instance_health.sql` changes `operational_worker_state` identity from worker role alone to `(worker_key, instance_id)`. This makes concurrent containers/processes separately observable while preserving the aggregate `workers` diagnostics consumed by existing callers.

System diagnostics additionally expose `workerInstances` and `workerWarnings`. Instance diagnostics include role, instance ID, version, commit SHA, start/heartbeat timestamps, state, and available hostname/container metadata. Warnings identify duplicate live instances of a singleton worker role, version/commit skew, and stale instances.

Stale instance records older than 24 hours are pruned by the canonical activity heartbeat function. This expiry is diagnostic housekeeping only. **Heartbeat rows are not a correctness lock.** Automation jobs continue to rely on the existing PostgreSQL advisory-lock ownership in `src/automation/job-health.js`; do not replace that locking with heartbeat checks.

A normal singleton deployment should show one non-stale, non-draining live instance for each expected worker role and no duplicate/version-skew warnings.

## Payment-provider HTTP deadlines

Native PayPal OAuth and API requests use `src/payments/provider-http.js`. Stripe's SDK client is configured with the same application-level timeout source. Plisio retains its existing explicit 15-second `AbortController` deadline.

The default shared Stripe/PayPal deadline is **15 seconds**. It can be changed globally with `PAYMENT_PROVIDER_HTTP_TIMEOUT_MS` or per provider with `PAYPAL_HTTP_TIMEOUT_MS` / `STRIPE_HTTP_TIMEOUT_MS`. Values are bounded to 50 ms–120 seconds. Provider HTTP responses handled by the shared transport are limited to 1 MiB before JSON parsing.

Timeout/network failures are marked retryable. HTTP 408, 425, 429 and 5xx responses are retryable; ordinary 4xx responses are permanent unless provider-specific logic says otherwise. PayPal debug/request IDs are captured from response headers, and Stripe SDK request IDs are captured from provider errors. Logging helpers expose only provider, classification, status, retryability, and request ID; credentials and response bodies are not logged.

Trusted Stripe and PayPal provider URLs remain owned by their provider adapters. They are not routed through the generic integration SSRF policy.

## Verification

`npm run check:fast` includes `scripts/operational-robustness-smoke.js`, covering bounded request concurrency, diff guards, duplicate/version-skew/stale worker diagnostics, provider deadline termination, retry classification, request-ID capture, and successful provider response handling.

`npm run check:db` includes `scripts/request-user-sync-smoke.js`, which exercises the real request-sync state machine against a local HTTP request-service fixture. It verifies that a second unchanged sync emits zero permission/main-settings mutations and that a forced failure for one remote user does not prevent other users from converging.
