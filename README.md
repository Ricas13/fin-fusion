# CAPTAiNFiN

CAPTAiNFiN is a self-hosted platform for managing Jellyfin and Stremio customers, subscriptions, billing, affiliates, storefronts and a multi-server Jellyfin fleet. PostgreSQL is the system of record; scheduled mutation work runs in dedicated workers; public, customer and administration experiences are database-backed.

## Capabilities

- Multi-server Jellyfin registry, health, libraries, capacity and placement.
- Customer registration, imported Jellyfin users, claims and activation links.
- Free, trial, one-time and recurring plans for Jellyfin, Stremio and bundles.
- Per-plan stream, download, transcoding, library and request policies.
- Independent Free/Premium Jellyfin access lanes and Stremio access.
- Stripe, PayPal and Plisio checkout.
- Affiliate referrals and currency-scoped CAPTAiNFiN service credit.
- Configurable storefront ordering, availability and Free Access lifecycle rules.
- Seerr/Overseerr account synchronisation and request policy.
- Transactional email and configured notification channels.
- Provisioning/reconciliation, entitlement expiry and billing verification.
- Playback/activity metrics, fleet stream visibility and commerce reporting.
- Encrypted PostgreSQL backup/restore tooling.
- Portable non-secret configuration export/import.

## Payment providers

| Provider | One-time | Recurring | Mixed service credit | Notes |
| --- | --- | --- | --- | --- |
| Stripe | Yes | Yes | Yes | Recurring credit applies to the first checkout; later renewals use the configured plan price. |
| PayPal | Yes | Yes | One-time only | Mixed credit is intentionally not applied to recurring Billing Plans. |
| Plisio | Yes | No | No | Crypto checkout is one-time only; there is no automatic renewal. |

Provider state is never inferred from browser success alone. Verified provider callbacks/webhooks and CAPTAiNFiN's local checkout contract remain authoritative.

## Architecture

```text
Browser / reverse proxy
        |
        v
   app (Node 22 / Express)
        |
        +---- PostgreSQL 17
        +---- Jellyfin fleet
        +---- Stripe / PayPal / Plisio
        +---- SMTP / request services / notification integrations

   automation-worker  -> singleton scheduled platform jobs
   activity-worker    -> Jellyfin playback/activity collection and policy enforcement
   backup-worker      -> encrypted PostgreSQL backup/verification
```

PostgreSQL is authoritative. The original JSON datastore and early single-server scripts are migration history, not the production architecture.

## Requirements

- Docker Engine and Docker Compose v2.
- HTTPS reverse proxy for public deployments.
- At least one Jellyfin server before Jellyfin accounts can be provisioned.

A clean installation can start with zero servers, customers and payment providers.

## Quick start

```bash
git clone https://github.com/Ricas13/fin-fusion.git captainfin
cd captainfin
bash install.sh
```

`install.sh` is the supported fresh-install entry point. It preserves an existing `.env`, generates independent secrets for a new install, prepares runtime database roles and encrypted backups, runs migrations and deployment checks, and prints a one-time first-admin claim code when appropriate.

The application binds to `127.0.0.1:3030` by default. Put an HTTPS reverse proxy in front of it rather than exposing the application container directly.

For an existing production checkout on `main`:

```bash
bash update.sh
```

`update.sh` refuses tracked local changes, fast-forwards from `origin/main`, and delegates to the production deployment script.

Detailed production deployment and rollback guidance lives in `docs/PRODUCTION_DEPLOYMENT.md`.

## First-run order

A sensible initial administration sequence is:

1. Resolve setup-readiness warnings.
2. Configure public URL, branding and support/legal details.
3. Add Jellyfin servers and synchronise libraries.
4. Create/configure Jellyfin, Stremio and bundle plans.
5. Configure payment providers and plan mappings.
6. Configure affiliate/referral policy if used.
7. Configure notification channels and transactional email.
8. Confirm automation/activity workers are healthy.
9. Enable storefront and public registration when ready.

To rotate/retrieve a first-run claim code before the first administrator exists:

```bash
docker compose exec app npm run setup:claim
```

If the application container is not running:

```bash
docker compose run --rm app npm run setup:claim
```

After the first administrator exists, the claim command fails closed.

## Services and compatibility identifiers

The Compose stack currently uses persistent historical service identifiers:

- `steam-fusion` — web/admin/customer application.
- `steam-fusion-automation` — scheduled singleton jobs.
- `steam-fusion-activity` — Jellyfin activity/fleet worker.
- `steam-fusion-backup` — encrypted backup/verification worker.
- `steam-fusion-postgres` — PostgreSQL.
- `migrate` — one-shot migration/bootstrap service.

These `steam-fusion` / `steamfusion` names are **compatibility identifiers**, not the public product name. They can be referenced by existing volumes, cookies, PostgreSQL roles/GUCs, backup tooling and deployment assumptions. Do not mass-rename them as a branding cleanup; any future rename must be an explicit migration with rollback support.

The public product name is **CAPTAiNFiN**.

## Database migrations

Run migrations manually with:

```bash
npm run db:migrate
```

Migration filenames and checksums are deployment history. Never rename or edit an already-applied migration; add a new migration instead.

The old JSON importer remains only for deliberate one-time migration from the retired datastore. It now requires explicit confirmation and refuses a destination that already contains customer/subscription/Jellyfin-account data unless a separate dangerous override is supplied:

```bash
npm run legacy:import-json -- --confirm-legacy-migration
```

Do not use the legacy importer for ordinary backups, restores, upgrades or customer imports.

## Backups

Create an encrypted PostgreSQL backup with:

```bash
npm run db:backup
```

Restore tooling is available through the `recovery-tools` Compose profile. Test restores before relying on a backup strategy.

## Security model

- PostgreSQL-backed staff/customer identities with bcrypt password hashes.
- PostgreSQL-backed sessions and persistent login throttling.
- Optional administrator/customer TOTP with recovery codes where configured.
- One-time activation, claim, verification and reset links store token hashes rather than plaintext tokens.
- Jellyfin, payment, request and email credentials are encrypted at rest with purpose-specific keys.
- Authenticated mutations use CSRF/origin protection.
- Provider callbacks/webhooks require verification and idempotent processing.
- Access holds compose independently so one subsystem cannot accidentally clear another restriction.
- Service-credit reservations prevent concurrent/double spending during unresolved checkout.
- Public verification links use confirmation POSTs rather than irreversible GET mutations.

Invitation onboarding is retired. Current acquisition uses public registration when enabled, administrator-created accounts, Jellyfin import/claim workflows and one-time activation links.

## Checks

Install dependencies and run the normal fast validation suite:

```bash
npm ci
npm run check
```

Run database-backed release checks with:

```bash
npm run check:release
```

GitHub Actions additionally exercise clean-install and upgrade paths, route ownership, lifecycle/concurrency invariants, browser regressions, checkout contracts, Stremio behavior, release integrity and CodeQL.

## Start commands

Production:

```bash
npm start
```

Development:

```bash
npm run dev
```

Both execute `src/application.js`, the explicit application-composition root.

## Project structure

```text
src/application.js            explicit Express composition
src/auth/                     authentication, sessions, 2FA, activation/setup
src/entitlements/             effective access + composable holds
src/jellyfin/                 registry, placement, provisioning, reconciliation
src/payments/                 Stripe/PayPal/Plisio, checkout, lifecycle and accounting
src/stremio/                  Stremio sources/runtime/delivery
src/integrations/             request service, email/outbox and integrations
src/automation/               singleton job registry/health
src/platform/                 admin/customer/storefront routes and UI
db/migrations/                PostgreSQL baseline and upgrade migrations
scripts/                      operations, workers and regression checks
docs/                         deployment and operational documentation
```

## License

MIT. See `LICENSE`.
