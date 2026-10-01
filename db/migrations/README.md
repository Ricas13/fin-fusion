# Database migrations

Historical CAPTAiNFiN migrations are immutable. Several shipped files intentionally share old three-digit prefixes, so they must not be renamed to repair numbering.

## Migration epoch

The current clean-install epoch is `baseline-v1-20260818`, owned by `scripts/migration-epochs.js`. Its baseline file is `000_database_baseline.sql`, created by commit `70d8688dcdf91fc78f1a96e84c0364962bc1b207`.

The epoch records any migration identities that are safely represented by the baseline and may therefore be skipped on a clean install. For v1 that set is intentionally empty: `001_remove_retired_product.sql` and `002_add_runtime_session_store.sql` were committed alongside the baseline, but they are still required companion migrations (for example, `002` creates `user_sessions`, which is not in the baseline dump). Later three-digit migrations are also post-baseline incrementals even though their names use the legacy numbering scheme.

A fresh database therefore applies the v1 baseline and every subsequent immutable migration. A future v2 baseline may compact that clean-install path only after it is generated from, and verified against, a fully migrated current schema. Existing installations never skip or rewrite their recorded historical migrations: `schema_migrations` checksums remain the upgrade authority, and reviewed drift recovery stays explicit.

The epoch metadata is deliberately separate from migration SQL. When a future clean-install baseline is introduced, add it as a reviewed migration-era change and update the epoch contract; do not rename, edit, delete, or silently reclassify historical migration identities.

## New migrations

All new migrations must use a UTC timestamp identifier:

```
YYYYMMDDHHMMSS_short_description.sql
```

Example:

```
20260829170000_database_operational_hardening.sql
```

Use the UTC creation time to second precision and check the migrations directory before committing. Parallel branches must choose different timestamp identifiers. Do not add new `NNN_...sql` migrations.

`scripts/migration-id-smoke.js` freezes the existing legacy migration population and rejects malformed future names or duplicate 14-digit timestamp identifiers. It runs in the normal fast CI suite.

Migration/deploy credentials remain schema owners. Runtime application and worker roles receive access only after migrations via `scripts/configure-runtime-db-roles.js`; new tables and functions are not automatically exposed to runtime roles.
