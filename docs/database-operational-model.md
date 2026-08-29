# Database operational model

## Runtime roles

`DATABASE_URL` is the migration/deploy/schema-owner credential. Runtime services must use their isolated roles and `scripts/configure-runtime-db-roles.js` is the canonical grant owner.

The web role intentionally keeps broad **SELECT/INSERT/UPDATE on existing tables** for deployment compatibility while the current route inventory is narrowed. It no longer receives blanket DELETE. DELETE is limited to explicit session/token, preference/mapping, cache/lease, provisioning-account and admin configuration tables listed in `APP_DELETE_TABLES`.

Additional web boundaries:

- `schema_migrations`, playback history and worker-health/poll state are read-only.
- authentication events and other event/ledger-style history in `APP_APPEND_ONLY_TABLES` may be read/inserted but not updated/deleted.
- `customers` and `subscriptions` cannot be directly deleted by the web role.
- payment event processing records and provider operation recovery records cannot be directly deleted by the web role.
- customer hard deletion is executed through `finalize_customer_deletion(uuid)`.
- retention and expired network-lease cleanup are executed only by the automation role through their constrained security-definer functions.

The automation role keeps broader mutation access because existing lifecycle/provisioning jobs span many tables, but authentication secrets and direct portal identity mutation remain excluded. Generic automation DELETE is explicitly revoked from financial ledgers, subscriptions, payment/provider recovery records and related immutable finance history.

No runtime role receives automatic access to objects created by future migrations. New migrations must deliberately grant any runtime capability they introduce. Migration/deploy ownership is not changed.

## Retention classes

The canonical configuration is `platform_settings.data_retention_v1`. Defaults are deliberately conservative and each invocation deletes at most 1,000 rows, with a configured default batch of 500. The automation job runs hourly by default.

| Data class | Default | Eligibility / safeguard |
| --- | ---: | --- |
| `playback_history` | 180 days | ended playback only; active/incomplete rows survive |
| `auth_events` | 365 days | append-only security event history |
| `audit_log` | 730 days | finance/provider/subscription audit actions/entities are excluded |
| `payment_events` | 365 days | processed successfully only; pending and `processing_error` rows survive |
| `provider_operations` | 365 days | only `reconciled`/`compensated`; `planned`, `provider_applied`, `local_applied`, `failed` survive |
| `notification_outbox` | 90 days | only `sent`/`cancelled`; pending/sending/failed/dead survive |
| `access_network_events` | 90 days | historical admission decisions only |
| `stream_policy_events` | 90 days | historical stream-policy decisions |
| `provisioning_runs` | 180 days | succeeded runs only; started/failed survive |
| `customer_download_events` | 180 days | completed event history |
| `stremio_stream_attribution` | 180 days | historical attribution records |

Expired `access_network_leases` are housekeeping rather than historical retention. They are removed in bounded batches by `cleanup_expired_access_network_leases()` using the existing `expires_at` index. Household/network admission policy is unchanged.

`automation_job_state` and `operational_worker_state` are current-state health/outcome rows, not append-only histories, so retention does not delete them. Financial/accounting owners such as affiliate credit ledgers, payment incidents, subscriptions and service-extension/reversal ledgers are intentionally outside operational retention.

Every retention class uses an index matching its cutoff predicate. Batches use `FOR UPDATE SKIP LOCKED` and the database owner records an audit event when rows are actually removed. This keeps each worker run bounded and observable without turning no-op housekeeping into another high-volume history stream.

## Playback partitioning

`playback_history` remains a normal table. Its current access pattern is customer/time oriented and the hardening migration adds an ended-time retention index so bounded deletion is cheap. There is not enough evidence in the repository to justify a risky in-place partition migration now. Partitioning should be reconsidered only with measured table/index size, delete/vacuum pressure and query-latency evidence.
