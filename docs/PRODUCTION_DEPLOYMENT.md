# Production deployment

This is the supported deployment/upgrade path for the Docker Compose installation.

The important safety rule is: **do not recreate the long-running containers until migrations and runtime database-role bootstrap have completed successfully.** Since the runtime-role isolation work, the application, automation, activity and backup processes use separate PostgreSQL identities rather than the database owner login.

## Normal CAPTaINFiN production update

On the production host:

```bash
cd /opt/captainfin-store
git fetch origin
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

The deployment command performs the following sequence:

1. Refuses to deploy tracked local source changes.
2. Validates `.env` and generates any missing isolated runtime DB URLs with independent high-entropy passwords.
3. Saves the old `.env` before adding generated runtime credentials.
4. Validates the full Docker Compose configuration.
5. Creates a compressed-format PostgreSQL pre-deploy backup when an existing database container is present.
6. Builds the new images while the currently-running portal remains online.
7. Runs database migrations, runtime-role creation/password rotation and administrator bootstrap in the one-shot migration container.
8. Recreates the application and worker containers only after that one-shot migration step succeeds.
9. Waits for Docker health checks on the web app, automation worker, activity worker and backup worker.
10. Runs `npm run verify:deployment` from the live application container.

If a deployment step fails, the script exits non-zero and prints Compose state plus recent service logs.

## First deployment after runtime-role isolation

Older CAPTaINFiN `.env` files may have only the owner `DATABASE_URL` and `ACTIVITY_DATABASE_URL`. The deployment helper fills the five current runtime URLs when they are missing:

```text
APP_DATABASE_URL
AUTOMATION_DATABASE_URL
ACTIVITY_DATABASE_URL
BACKUP_DATABASE_URL
BACKUP_VERIFY_DATABASE_URL
```

Each generated URL points at the same PostgreSQL host/database as `DATABASE_URL`, uses the required runtime role name, and gets a unique random password. Existing values are validated rather than silently replaced. Weak, duplicate, owner-reused or wrong-role credentials fail closed.

To prepare/validate the environment without deploying:

```bash
node scripts/prepare-production-env.js --write
node scripts/prepare-production-env.js --check
```

If Node is not installed on the host, the full production deployment script automatically runs the helper through the Node 22 Docker image.

## Stremio rollout

A normal portal deployment should leave:

```text
STREMIO_RUNTIME_ENABLED=false
```

until the Stremio delivery server, media index and dedicated `STREMIO_JELLYFIN_TOKEN_KEY` are verified. Deploying the code does not by itself make Stremio products sale-ready.

## Verification

After deployment, the command must finish with healthy containers and a passing application-level deployment verification. You can rerun the checks manually:

```bash
docker compose ps
docker compose exec -T app npm run verify:deployment
```

The app should remain bound to `127.0.0.1:3030`; the public HTTPS endpoint should continue to be provided by the existing reverse proxy.

## Pre-deploy backups

Upgrade backups are written to:

```text
backups/predeploy/steamfusion-YYYYMMDDTHHMMSSZ.dump
```

They are PostgreSQL custom-format dumps (`pg_dump -Fc`). Keep the normal encrypted scheduled backup system enabled as the primary backup mechanism; the pre-deploy dump is an additional upgrade safety point.

## Manual fallback sequence

If the deployment helper cannot be used, preserve the same ordering:

```bash
node scripts/prepare-production-env.js --write
docker compose config
docker compose build app automation-worker activity-worker backup-worker migrate
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps app automation-worker activity-worker backup-worker
docker compose exec -T app npm run verify:deployment
```

Take a database backup before the migration step. Never go directly from an older deployment to `docker compose up -d --build app` now that runtime DB isolation is part of the supported architecture.
