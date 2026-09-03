# Audit follow-up — 2026-09-03

This follow-up PR closes the remaining repository-level observability gaps that can be validated safely in CI.

## Completed in this PR

- live PostgreSQL pool pressure on Settings → System;
- process-local reconciliation active/queued/limit/failure/lock-wait telemetry;
- durable recovery backlog counts for payment events, provider operations, automatic Free downgrade retries and customer provisioning problems;
- fail-visible handling when optional metric collection is unavailable;
- sanitized operational counters in the downloadable support report;
- Customer 360 per-service desired versus observed reconciliation truth for Jellyfin primary, Jellyfin Free, Emby, Stremio and Discord roles;
- direct regression coverage using the existing fast and database suites.

## Deliberately not implemented as static code changes

The following require a deployed or staging environment with representative traffic and cannot be proven by repository inspection alone:

- Cloudflare → Traefik → Express live visitor-IP chain validation;
- production-size `EXPLAIN ANALYZE` for Customer 360/activity/entitlement queries;
- 24-hour staging soak under concurrent payment, provisioning and playback activity;
- process heap/event-loop/active-handle observation under real load;
- reconciliation latency distribution using representative traffic rather than process-lifetime averages;
- full backup restore drill into a clean environment and application startup against the restored database.

Those are operational acceptance checks, not known unresolved repository defects.
