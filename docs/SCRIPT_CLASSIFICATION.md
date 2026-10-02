# Script classification

CAPTAiNFiN keeps scripts in the existing `scripts/` tree while the test estate is consolidated incrementally. A risky bulk rename is intentionally avoided.

## Runtime

These execute as long-running production processes and must remain in the production image:

- `automation-worker.js`
- `activity-worker.js`
- `backup-worker.js`
- `backup-healthcheck.js`

## Operator / deployment / recovery

These are invoked by supported deployment, backup, restore, installation or operator workflows and must remain available in the production image where their owning Compose service needs them:

- database migration/runtime-role/bootstrap tooling
- backup / offsite-backup / inspect / verify / restore tooling
- deployment verification and production-environment preparation
- supported one-off operator commands such as server/provider mapping utilities

## CI / test only

These are checkout-only and must not be copied into the production image:

- `*-smoke.js`
- `*-audit.js`
- `check-*.js`
- `smoke-db.js`
- `db-test-fixture.js`
- `dead-code-audit.js`
- `run-check-suite.js`
- `run-tagged-checks.js`

The tagged check manifest remains the transition source of truth for suite composition. New test-only helpers should be obviously test-scoped and added to the production-image content contract before use.

## Directory transition

Do not bulk-move hundreds of scripts in one PR. New script families may adopt `scripts/ci/`, `scripts/runtime/` and `scripts/ops/` incrementally when doing so does not create compatibility or deployment risk. Existing paths remain stable until their callers are migrated in the same reviewed change.
