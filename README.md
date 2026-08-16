# CAPTAiNFiN / Steam Fusion

CAPTAiNFiN is a self-hosted Jellyfin customer, reseller, subscription, billing and fleet-management platform. This fork has moved well beyond the original JSON-file Steam Fusion application: PostgreSQL is the system of record, Jellyfin servers are managed as a fleet, customer and reseller commerce are separate, background automation runs in dedicated workers, and the public storefront/admin/customer/reseller experiences are all database-backed.

## What it manages

- Multiple Jellyfin servers, health, libraries, capacity and fleet-aware placement.
- Direct customers, invitations, imported Jellyfin users, account claims and one-time activation links.
- Customer plans with stream/download/transcoding/library/request policies.
- Stripe and PayPal one-time or recurring customer checkout.
- Monthly reseller tiers with active-customer entitlement limits, recurring billing, grace handling and tier-specific downstream plan catalogues.
- Central Seerr/Overseerr account synchronisation and per-plan request quotas.
- Transactional email, Telegram notifications and encrypted delivery outbox.
- Provisioning/reconciliation, billing verification, entitlement expiry, reseller-estate enforcement and other singleton automation jobs.
- Playback/activity metrics, live fleet streams, reseller sales ledger and recurring-commerce reporting.
- Portable non-secret configuration export/import for clean installs and migration.

## Architecture

The supported runtime is:

```text
Browser / reverse proxy
        |
        v
   app (Node 22 / Express)
        |
        +---- PostgreSQL 17
        |
        +---- Jellyfin fleet
        |
        +---- Stripe / PayPal / SMTP / Seerr (optional)

   automation-worker  -> singleton scheduled platform jobs
   activity-worker    -> Jellyfin playback/activity collection and policy enforcement
```

PostgreSQL is authoritative. `db/data.json`, the original single-server JSON scripts and the historical Express preload monkey-patches are not the production architecture.

## Requirements

- Docker Engine + Docker Compose is the recommended deployment path.
- PostgreSQL 17 is included in the Compose stack.
- A reverse proxy terminating HTTPS is recommended for public deployments.
- At least one Jellyfin server is required before accounts can actually be provisioned, but a clean installation can start with zero servers, plans, customers, resellers or payment providers.

## Quick start

```bash
git clone https://github.com/Ricas13/steam-fusion.git captainfin
cd captainfin
cp .env.example .env
```

Generate independent high-entropy values for every encryption/session key in `.env`, set the PostgreSQL passwords/URLs, then start the stack:

```bash
docker compose up -d --build
```

The `migrate` service applies schema migrations and bootstraps an unattended administrator only when both `ADMIN_USERNAME` and `ADMIN_PASSWORD` are supplied. Otherwise open the app and follow the one-time browser setup flow.

The app listens on `127.0.0.1:3030` by default. Put your HTTPS reverse proxy in front of it rather than exposing the container directly to the internet.

For upgrades of an existing production installation, use the supported SSH-resilient deployment command instead of a direct Compose rebuild:

```bash
bash scripts/deploy-production.sh
```

That command prepares runtime DB identities, persists the host backup UID/GID, serialises image builds to reduce peak resource usage, makes an encrypted pre-deploy backup, migrates first, recreates runtime services only after migration success, and verifies the live deployment. See `docs/PRODUCTION_DEPLOYMENT.md`.

## First-run setup

A genuinely blank database starts safely with customer-facing features off. The setup flow creates the first native administrator and permanently locks the installer afterwards.

Recommended order in Administration:

1. **Setup / Configuration Health** — review readiness and dependency warnings.
2. **Branding / General / Reseller Settings** — set installation identity and commercial defaults.
3. **Servers / Libraries** — add Jellyfin servers, test them and synchronise libraries.
4. **Plans / Reseller Plans** — create customer plans and optional monthly reseller tiers.
5. **Payments** — configure encrypted browser-managed Stripe/PayPal credentials and plan/tier mappings.
6. **Notifications** — configure SMTP and/or Telegram.
7. **Automation** — confirm the dedicated worker is reporting successful runs.
8. **Storefront / Registration** — enable public-facing features only when the installation is ready.

## Services

```bash
docker compose ps
```

The normal stack contains:

- `steam-fusion` — web/admin/customer/reseller application.
- `steam-fusion-automation` — scheduled singleton jobs using PostgreSQL advisory locks.
- `steam-fusion-activity` — Jellyfin activity/fleet metrics worker with a restricted DB role.
- `steam-fusion-backup` — encrypted database backup/verification worker using the host backup-directory UID/GID.
- `steam-fusion-postgres` — PostgreSQL.
- `migrate` — one-shot schema migration/bootstrap service.

`recovery-tools` is an opt-in Compose profile for encrypted backup/restore operations.

## Database migrations

Application containers depend on the one-shot migrate service. To run migrations manually:

```bash
npm run db:migrate
```

Migrations are checksum-tracked. Do not edit an already-applied migration; add a new numbered migration.

## Security model

- Native PostgreSQL-backed staff/customer identities with bcrypt password hashes.
- PostgreSQL-backed sessions and persistent login throttling.
- Optional administrator/reseller TOTP with recovery codes; global enforcement is configurable.
- One-time activation, invitation, claim, verification and reset links store validation hashes rather than plaintext tokens.
- Jellyfin/payment/request/email credentials are encrypted at rest using purpose-specific installation keys.
- CSRF/origin protection is applied to authenticated state-changing routes.
- Provider webhooks require provider signature verification and idempotent processing.
- CAPTaINFiN-managed access uses independent composable holds so billing/admin/reseller restrictions cannot accidentally clear one another.
- Provider-managed recurring subscriptions are never silently rewritten into manual/reseller-credit entitlements.

Never reuse `DATA_ENCRYPTION_KEY`, `JELLYFIN_ENCRYPTION_KEY`, `AUTH_ENCRYPTION_KEY`, `ACTIVITY_ENCRYPTION_KEY` or `BACKUP_ENCRYPTION_KEY`.

## Customer commerce

Direct plans may be one-time, recurring, trial or free. Server-side audience checks prevent reseller-only plans from being purchased through customer endpoints.

Existing recurring customers use controlled plan changes instead of creating overlapping recurring subscriptions:

- Stripe upgrades can be applied immediately with provider proration.
- Stripe downgrades can be scheduled for period end.
- PayPal plan changes preserve the current paid-through period and require a new authorisation when the replacement subscription starts.

Customer portal users can inspect their subscription/payment history and provider references without seeing secrets.

## Reseller commerce

Monthly reseller billing is the primary reseller model. Each tier defines:

- Monthly price/currency.
- Active customer entitlement limit.
- Optional payment grace period.
- Stripe/PayPal recurring product mapping.
- Optional explicit downstream customer-plan catalogue.

Commercial terms are snapshotted into each reseller subscription, so later tier edits do not silently change an already-paid agreement. A reseller's own Jellyfin account, when allowed, consumes one active entitlement.

Legacy regular/trial credits remain visible only as a migration/history compatibility path.

## Automation

Recurring mutation work is not run by every web replica. The dedicated automation worker owns jobs such as:

- Jellyfin health checks.
- Entitlement expiry/reconciliation.
- Customer billing verification.
- Scheduled customer plan changes.
- Reseller billing verification and estate transitions.
- Request-user synchronisation.
- Transactional email outbox delivery.
- Bulk-job processing and stale-job recovery.

Administration → Automation shows enabled state, interval, last run, last success, duration, processed count, errors and a safe **Run now** request.

## Configuration export/import

Administration can export a versioned portable configuration document containing non-secret business configuration such as plans, request quotas, reseller tiers, tier plan rules, provider mapping references, storefront settings and automation schedules.

Exports deliberately exclude secrets, customer/reseller identities, provider customer/subscription identities, sessions, audit/auth history and branding binary assets.

Version 2 imports remain backward-compatible with version 1 files.

## Backups

Use the encrypted PostgreSQL backup tooling rather than copying application state files:

```bash
npm run db:backup
```

Restore tooling is available through the `recovery-tools` Compose profile. Test restores before relying on a backup strategy. Production deployment verification treats an enabled backup loop with a current failure as unhealthy rather than accepting heartbeat-only liveness.

## Production checks

Static/smoke checks:

```bash
npm ci
npm run check
```

Production-readiness audit:

```bash
node scripts/production-readiness.js
```

The readiness audit uses the same browser-managed integration status and Jellyfin placement logic as the application. A blank install may legitimately have no servers or plans; those become operational warnings rather than startup corruption.

## Supported start commands

Production:

```bash
npm start
```

Development:

```bash
npm run dev
```

Both execute `src/application.js`, the single explicit application-composition root. `app.js`, `secure-start.js` and the old preload filenames remain thin/no-op compatibility entrypoints only so older deployment commands fail safely during upgrades.

## Project structure

```text
src/application.js            explicit Express composition
src/auth/                     authentication, sessions, 2FA, activation/setup
src/entitlements/             effective subscription + composable access holds
src/jellyfin/                 registry, placement, provisioning, reconciliation
src/payments/                 Stripe/PayPal, lifecycle, checkout intents, billing
src/resellers/                monthly reseller entitlement and commercial policy
src/integrations/             request service, SMTP/outbox and integrations
src/automation/               singleton job registry/health
src/platform/                 admin/customer/reseller/storefront routes and UI
db/migrations/                immutable PostgreSQL migrations
scripts/                      supported operations/workers/smoke checks
```

## Legacy migration note

The project originated from a small JSON-file Steam Fusion reseller panel. Legacy JSON import remains available for migration purposes, but the JSON database and old single-server expiry/import scripts are not supported runtime components.

## License

MIT. See `LICENSE`.
