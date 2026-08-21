# CAPTAiNFiN / Steam Fusion

CAPTAiNFiN is a self-hosted platform for managing Jellyfin and Stremio customers, subscriptions, billing, affiliates, storefronts and a multi-server Jellyfin fleet. PostgreSQL is the system of record, scheduled mutation work runs in dedicated workers, and the public, administration and customer experiences are database-backed.

## What it manages

- Multiple Jellyfin servers, health, libraries, capacity and fleet-aware placement.
- Direct customers, imported Jellyfin users, portal claims and one-time activation links.
- Customer plans with stream, download, transcoding, library and request policies.
- Jellyfin, Stremio and bundle products with consistent plan configuration.
- Stripe and PayPal one-time or recurring customer checkout.
- Affiliate referral attribution with currency-specific CAPTAiNFiN service credit.
- Affiliate accounts that can earn credit without holding an active subscription.
- Full-credit plan activation plus mixed service-credit + Stripe checkout and mixed service-credit + one-time PayPal checkout.
- Multi-currency customer pricing with price-scoped provider mappings.
- A permanent Free Access tier that remains visible even when no free places are available.
- Configurable storefront ordering for customer, Stremio and bundle plans.
- Central Seerr/Overseerr account synchronisation and per-plan request quotas.
- Transactional email and configured notification channels.
- Provisioning/reconciliation, billing verification and entitlement expiry.
- Playback/activity metrics, live fleet streams and recurring-commerce reporting.
- Portable non-secret configuration export/import for clean installs and migrations.

## Affiliate and service-credit model

An affiliate is a normal CAPTAiNFiN customer account. The account does **not** need an active subscription to participate or accumulate service credit.

A qualifying referred payment awards a configurable percentage of the paid amount as service credit in the same currency. Credit has a qualification/refund window and remains separated by currency; CAPTAiNFiN does not silently perform FX conversion.

Available credit can be used in three ways:

- If the balance covers an eligible plan, the plan is activated directly with subscription source `service_credit`; Stripe/PayPal are not involved.
- If the balance is smaller than the plan price, it can be reserved against a Stripe checkout and only the remaining amount is charged by Stripe. For recurring Stripe checkout, the credit adjustment applies to the first checkout while later renewal pricing remains the configured plan price.
- The same partial-credit model is supported for one-time PayPal Orders. Recurring PayPal Billing Plans are intentionally excluded from mixed credit because altering their plan amount would change recurring billing semantics; customers can instead use Stripe, a one-time PayPal option, or enough credit to activate directly.

Credit reservations are checkout-scoped so the same balance cannot be spent twice while a provider checkout is in progress. Verified completion converts the reservation into a redeemed ledger entry; cancellation/failure releases it. Refund and chargeback handling reverses only credit that is still economically recoverable and does not claw back service already delivered.

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

- Docker Engine + Docker Compose v2 is the recommended deployment path.
- PostgreSQL 17 is included in the Compose stack.
- A reverse proxy terminating HTTPS is recommended for public deployments.
- At least one Jellyfin server is required before Jellyfin accounts can be provisioned, but a clean installation can start with zero servers, customers or payment providers.

## Quick start

```bash
git clone https://github.com/Ricas13/fin-fusion.git captainfin
cd captainfin
bash install.sh
```

`install.sh` is the supported fresh-install entry point. It:

1. Verifies Docker Engine and Docker Compose v2.
2. Creates `.env` only when it is missing and never overwrites existing installation secrets.
3. Generates independent high-entropy PostgreSQL, encryption, backup, Stremio-token and session secrets without printing them.
4. Delegates isolated runtime database credentials to the production runtime-role generator.
5. Prepares the encrypted-backup bind mount with a non-root container identity.
6. Runs the same migration, health, backup and deployment verification path used for production upgrades.
7. Prints a fresh one-time first-run claim code after a successful interactive installation.

The web application remains bound to `127.0.0.1:3030`. Put an HTTPS reverse proxy in front of it rather than exposing the container directly.

The installer is safe to rerun after an interrupted first deployment: an existing `.env` is preserved and validated rather than regenerated.

For future updates from a normal `main` production checkout:

```bash
bash update.sh
```

`update.sh` refuses tracked local changes, fast-forwards from `origin/main`, then hands off to the SSH-safe production deployment script. The lower-level supported deployment command remains:

```bash
bash scripts/deploy-production.sh
```

See `docs/PRODUCTION_DEPLOYMENT.md` for the production deployment/rollback model.

## First-run setup

A blank database starts safely with customer-facing features off. A sensible administration order is:

1. **Setup readiness** — resolve readiness/dependency warnings.
2. **General & branding** — set installation identity, public URL and support links.
3. **Servers / Libraries** — add Jellyfin servers, test them and synchronise libraries.
4. **Plans** — configure Jellyfin, Stremio and bundle products.
5. **Storefront order** — arrange public plan ordering; Free Access stays featured separately.
6. **Payment providers** — configure provider credentials and price-specific mappings.
7. **Affiliates** — enable the programme and configure reward/qualification settings when wanted.
8. **Notifications** — configure available delivery channels and event policy.
9. **Automation** — confirm dedicated workers are healthy.
10. **Storefront / Registration** — enable public-facing acquisition when ready.

`install.sh` prints a fresh claim code when `ADMIN_USERNAME` and `ADMIN_PASSWORD` are intentionally left blank. You can rotate/retrieve another claim code directly from the running application container before the first administrator is created:

```bash
docker compose exec app npm run setup:claim
```

If the application container is not running yet:

```bash
docker compose run --rm app npm run setup:claim
```

After the first administrator exists, the claim command fails closed and the installer is locked.

## Services

```bash
docker compose ps
```

The normal stack contains:

- `steam-fusion` — web/admin/customer application.
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

Migrations are checksum-tracked. Do not edit an already-applied migration. Add a new migration instead.

## Security model

- PostgreSQL-backed staff/customer identities with bcrypt password hashes.
- PostgreSQL-backed sessions and persistent login throttling.
- Optional administrator/customer TOTP with recovery codes where configured.
- One-time activation, claim, verification and reset links store hashes rather than plaintext tokens.
- Jellyfin/payment/request/email credentials are encrypted at rest using purpose-specific keys.
- CSRF/origin protection covers authenticated state-changing routes.
- Provider webhooks require signature verification and idempotent processing.
- CAPTAiNFiN access holds compose independently so one subsystem cannot accidentally clear another restriction.
- Service-credit checkout reservations prevent concurrent/double spending while provider checkout is unresolved.

Invitation onboarding is retired. Customer acquisition uses public registration when enabled, administrator-created customer accounts, Jellyfin import/claim workflows and one-time activation links.

Never reuse `DATA_ENCRYPTION_KEY`, `JELLYFIN_ENCRYPTION_KEY`, `AUTH_ENCRYPTION_KEY`, `ACTIVITY_ENCRYPTION_KEY` or `BACKUP_ENCRYPTION_KEY`. The installer generates them independently on a fresh install.

## Customer commerce

Direct plans may be free, trial, one-time or recurring. Existing recurring customers use controlled plan changes rather than overlapping subscriptions:

- Stripe upgrades can apply immediately with provider proration.
- Stripe downgrades can be scheduled for period end.
- PayPal changes preserve the current paid-through period and require replacement authorisation when necessary.

The customer portal explains whether a plan change is immediate or scheduled before the customer continues to the payment provider.

The canonical Free Access tier is permanent in the catalogue. Setting its available capacity to zero closes new claims without hiding or deleting the tier.

Affiliate service credit is an account balance, not cash and not a payment-provider balance. It remains in the currency in which it was earned and can be applied only to matching-currency plan pricing.

## Configuration export/import

Administration can export a versioned portable configuration containing non-secret business configuration such as plans, pricing, delivery policy, affiliate settings, provider mapping references, storefront settings and automation schedules.

Exports exclude secrets, customer/affiliate identities and balances, provider customer/subscription identities, sessions, audit/auth history and branding binary assets. Imported provider mappings remain verification-safe rather than being blindly trusted.

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

GitHub Actions additionally exercise clean install/upgrade paths, route ownership, lifecycle/concurrency invariants, browser regressions, checkout contracts, affiliate service-credit accounting and CodeQL.

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
src/payments/                 Stripe/PayPal, lifecycle, checkout intents, billing, service-credit reservations
src/stremio/                  Stremio sources/runtime/delivery
src/integrations/             request service, email/outbox and integrations
src/automation/               singleton job registry/health
src/platform/                 admin/customer/storefront routes and UI
db/migrations/                PostgreSQL schema baseline and upgrade migrations
scripts/                      operations, workers and regression checks
```

## License

MIT. See `LICENSE`.