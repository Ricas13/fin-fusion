# CAPTAiNFiN / Steam Fusion

CAPTAiNFiN is a self-hosted platform for managing Jellyfin customers, reseller access, subscriptions, billing, storefronts and a multi-server Jellyfin fleet. PostgreSQL is the system of record, scheduled mutation work runs in dedicated workers, and the public/admin/customer/reseller experiences are database-backed.

## What it manages

- Multiple Jellyfin servers, health, libraries, capacity and fleet-aware placement.
- Direct customers, invitations, imported Jellyfin users, claims and one-time activation links.
- Customer plans with stream, download, transcoding, library and request policies.
- Stripe and PayPal one-time or recurring customer checkout.
- Monthly reseller plans that grant a configurable number of managed Jellyfin users.
- Plan-owned Jellyfin policy for reseller-managed users, including streams, transcoding, libraries and placement.
- Multi-currency customer and reseller pricing with price-scoped provider mappings.
- A permanent Free Access tier that remains visible even when no free places are available.
- Configurable storefront ordering for customer, Stremio/add-on and reseller plans.
- Central Seerr/Overseerr account synchronisation and per-plan request quotas.
- Transactional email and configured notification channels.
- Provisioning/reconciliation, billing verification, entitlement expiry and reseller-estate enforcement.
- Playback/activity metrics, live fleet streams and recurring-commerce reporting.
- Portable non-secret configuration export/import for clean installs and migrations.

## Reseller model

A reseller pays CAPTAiNFiN a monthly fee for a managed-user allowance. One reseller-managed Jellyfin user consumes one seat.

The reseller portal can add, suspend/resume, reset credentials for and delete managed Jellyfin users. Suspending a user keeps the seat occupied; deleting the managed user releases it. Managed users inherit the Jellyfin policy configured on the reseller plan.

The reseller's own commercial relationship with those users is deliberately outside CAPTAiNFiN. The live product does **not** provide a reseller credit wallet, downstream sales ledger, per-customer resale pricing or reseller CRM. Historical database structures may remain where required for safe upgrades/audit compatibility, but they are not active product behavior.

Reseller plans are monthly-only and may expose multiple configured prices/currencies. Stripe/PayPal mappings are scoped to the exact reseller price so identifiers cannot be reused across currencies accidentally.

## Architecture

```text
Browser / reverse proxy
        |
        v
   app (Node 22 / Express)
        |
        +---- PostgreSQL 17
        +---- Jellyfin fleet
        +---- Stripe / PayPal / SMTP / request services (optional)

   automation-worker  -> singleton scheduled platform jobs
   activity-worker    -> Jellyfin playback/activity collection and policy enforcement
   backup-worker      -> encrypted PostgreSQL backup/verification
```

PostgreSQL is authoritative. The original JSON database and single-server scripts are migration history, not the production architecture.

## Requirements

- Docker Engine + Docker Compose is the recommended deployment path.
- PostgreSQL 17 is included in the Compose stack.
- A reverse proxy terminating HTTPS is recommended for public deployments.
- At least one Jellyfin server is required before accounts can be provisioned, but a clean installation can start with zero servers, customers, resellers or payment providers.

## Quick start

```bash
git clone https://github.com/Ricas13/steam-fusion.git captainfin
cd captainfin
cp .env.example .env
docker compose up -d --build
```

Generate independent high-entropy values for every encryption/session key in `.env` and configure the PostgreSQL credentials/URLs before starting production services.

The `migrate` service applies schema migrations and bootstraps an unattended administrator only when both `ADMIN_USERNAME` and `ADMIN_PASSWORD` are supplied. Otherwise use the one-time browser setup flow.

The web application listens on `127.0.0.1:3030` by default. Put an HTTPS reverse proxy in front of it rather than exposing the container directly.

For an existing production installation use the supported deployment command:

```bash
bash scripts/deploy-production.sh
```

See `docs/PRODUCTION_DEPLOYMENT.md` for the production deployment/rollback model.

## First-run setup

A blank database starts safely with customer-facing features off. A sensible administration order is:

1. **Setup / Configuration Health** — resolve readiness/dependency warnings.
2. **Branding / General / Reseller Settings** — set installation identity and global behavior.
3. **Servers / Libraries** — add Jellyfin servers, test them and synchronise libraries.
4. **Plans / Reseller Plans** — configure customer, Stremio/add-on and reseller products.
5. **Storefront order** — arrange public plan ordering; Free Access stays featured separately.
6. **Payments** — configure provider credentials and price-specific mappings.
7. **Notifications** — configure available delivery channels and event policy.
8. **Automation** — confirm dedicated workers are healthy.
9. **Storefront / Registration** — enable public-facing acquisition when ready.

## Services

```bash
docker compose ps
```

The normal stack contains:

- `steam-fusion` — web/admin/customer/reseller application.
- `steam-fusion-automation` — scheduled singleton jobs using PostgreSQL advisory locks.
- `steam-fusion-activity` — Jellyfin activity/fleet worker with a restricted DB role.
- `steam-fusion-backup` — encrypted database backup/verification worker.
- `steam-fusion-postgres` — PostgreSQL.
- `migrate` — one-shot schema migration/bootstrap service.

`recovery-tools` is an opt-in Compose profile for encrypted backup/restore operations.

## Database migrations

Run migrations manually with:

```bash
npm run db:migrate
```

Migrations are checksum-tracked. **Do not edit an already-applied migration.** Add a new numbered migration instead.

## Security model

- PostgreSQL-backed staff/customer identities with bcrypt password hashes.
- PostgreSQL-backed sessions and persistent login throttling.
- Optional administrator/reseller TOTP with recovery codes; enforcement is configurable.
- One-time activation, invitation, claim, verification and reset links store hashes rather than plaintext tokens.
- Jellyfin/payment/request/email credentials are encrypted at rest using purpose-specific keys.
- CSRF/origin protection covers authenticated state-changing routes.
- Provider webhooks require signature verification and idempotent processing.
- CAPTAiNFiN access holds compose independently so one subsystem cannot accidentally clear another restriction.

Never reuse `DATA_ENCRYPTION_KEY`, `JELLYFIN_ENCRYPTION_KEY`, `AUTH_ENCRYPTION_KEY`, `ACTIVITY_ENCRYPTION_KEY` or `BACKUP_ENCRYPTION_KEY`.

## Customer commerce

Direct plans may be free, trial, one-time or recurring. Existing recurring customers use controlled plan changes rather than overlapping subscriptions:

- Stripe upgrades can apply immediately with provider proration.
- Stripe downgrades can be scheduled for period end.
- PayPal changes preserve the current paid-through period and require replacement authorisation when necessary.

The canonical Free Access tier is permanent in the catalogue. Setting its available capacity to zero closes new claims without hiding or deleting the tier.

## Configuration export/import

Administration can export a versioned portable configuration containing non-secret business configuration such as plans, pricing, reseller plans, policy, provider mapping references, storefront settings and automation schedules.

Exports exclude secrets, customer/reseller identities, provider customer/subscription identities, sessions, audit/auth history and branding binary assets. Imported provider mappings remain verification-safe rather than being blindly trusted.

## Backups

Use the encrypted PostgreSQL backup tooling:

```bash
npm run db:backup
```

Restore tooling is available through the `recovery-tools` Compose profile. Test restores before relying on a backup strategy.

## Checks

Static/smoke checks:

```bash
npm ci
npm run check
```

Full release checks:

```bash
npm run check:release
```

Production-readiness audit:

```bash
node scripts/production-readiness.js
```

GitHub Actions additionally exercise clean install/upgrade paths, route ownership, lifecycle/concurrency invariants, browser regressions, checkout contracts and CodeQL.

## Start commands

Production:

```bash
npm start
```

Development:

```bash
npm run dev
```

Both execute `src/application.js`, the explicit application-composition root. Older compatibility entrypoints remain thin/no-op wrappers only where required for safe upgrades.

## Project structure

```text
src/application.js            explicit Express composition
src/auth/                     authentication, sessions, 2FA, activation/setup
src/entitlements/             effective access + composable holds
src/jellyfin/                 registry, placement, provisioning, reconciliation
src/payments/                 Stripe/PayPal, lifecycle, checkout intents, billing
src/resellers/                monthly reseller entitlement and managed-seat policy
src/integrations/             request service, email/outbox and integrations
src/automation/               singleton job registry/health
src/platform/                 admin/customer/reseller/storefront routes and UI
db/migrations/                immutable PostgreSQL migrations
scripts/                      operations, workers and regression checks
```

## License

MIT. See `LICENSE`.
