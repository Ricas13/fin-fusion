# Database migrations

Historical CAPTAiNFiN migrations are immutable. Several shipped files intentionally share old three-digit prefixes, so they must not be renamed to repair numbering.

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
