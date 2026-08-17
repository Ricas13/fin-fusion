# Production deployment

This is the supported deployment/upgrade path for the Docker Compose installation.

The important safety rule is: **do not recreate the long-running containers until migrations and runtime database-role bootstrap have completed successfully.** Since the runtime-role isolation work, the application, automation, activity and backup processes use separate PostgreSQL identities rather than the database owner login.

## Normal CAPTAiNFiN production update

On the production host:

```bash
cd /opt/captainfin-store
git fetch origin
git checkout main
git pull --ff-only origin main
bash scripts/deploy-production.sh
```

The interactive command immediately starts the actual deployment as a detached `nohup` process, writes a persistent log under `logs/deploy-<timestamp>.log`, and follows that log while the SSH session remains connected. If SSH disconnects, the deployment continues. Reconnect and inspect the newest deployment log rather than starting a second run:

```bash
cd /opt/captainfin-store
LATEST="$(ls -1t logs/deploy-*.log | head -1)"
tail -n 200 -f "$LATEST"
```

A deployment lock prevents a second production rollout from starting over an active one.

The deployment command performs the following sequence:

1. Refuses to deploy tracked local source changes.
2. Validates `.env` and generates any missing isolated runtime DB URLs with independent high-entropy passwords.
3. Records the deployment user's UID/GID as `BACKUP_PUID`/`BACKUP_PGID` when those values are absent, so bind-mounted encrypted backups are written as the host account that owns `./backups`.
4. Saves the old `.env` before adding generated deployment values.
5. Validates the full Docker Compose configuration.
6. Starts/waits for PostgreSQL without recreating an existing database container.
7. Builds the new images while the currently-running portal remains online. Compose parallelism defaults to `1` to reduce peak memory/CPU pressure on small hosts.
8. Creates an **encrypted** pre-deploy PostgreSQL backup through the existing recovery tooling when this is an upgrade.
9. Runs database migrations, runtime-role creation/password rotation and administrator bootstrap in the one-shot migration container.
10. Recreates the application and worker containers only after that one-shot migration step succeeds.
11. The backup worker immediately retries a persisted failed backup after restart. This clears an old operational failure only after a new encrypted backup/verification succeeds.
12. Waits for Docker health checks on the web app, automation worker, activity worker and backup worker.
13. Runs `npm run verify:deployment` from the live application container. Backup failure state is a deployment blocker, not heartbeat-only success.

If a deployment step fails, the detached process exits non-zero and the persistent log contains Compose state plus recent service logs.

## First deployment after runtime-role isolation

Older CAPTAiNFiN `.env` files may have only the owner `DATABASE_URL` and `ACTIVITY_DATABASE_URL`. The deployment helper fills the five current runtime URLs when they are missing:

```text
APP_DATABASE_URL
AUTOMATION_DATABASE_URL
ACTIVITY_DATABASE_URL
BACKUP_DATABASE_URL
BACKUP_VERIFY_DATABASE_URL
```

Each generated URL points at the same PostgreSQL host/database as `DATABASE_URL`, uses the required runtime role name, and gets a unique random password. Existing values are validated rather than silently replaced. Weak, duplicate, owner-reused or wrong-role credentials fail closed.

The helper also fills these host filesystem identity values when run by a non-root deployment account:

```text
BACKUP_PUID
BACKUP_PGID
```

`backup-worker` and `recovery-tools` run with that numeric identity so a bind mount such as `/opt/captainfin-store/backups -> /backups` remains writable without changing the host directory to world-writable permissions.

To prepare/validate the environment without deploying:

```bash
node scripts/prepare-production-env.js --write
node scripts/prepare-production-env.js --check
```

If Node is not installed on the host, the full production deployment script automatically runs the helper through the Node 22 Docker image using the host caller's UID/GID.

## Stremio rollout

A normal deployment should configure the dedicated `STREMIO_JELLYFIN_TOKEN_KEY` as a 32-byte deployment secret, but **runtime enable/disable is managed in the browser** from **Settings → Integrations → Stremio**.

After deployment, keep the browser runtime switch disabled while preparing Stremio. Configure an eligible delivery server and build a ready media index, then use **Enable runtime** on the Stremio settings page. The server refuses that enable action unless the secret key, at least one healthy eligible delivery server and at least one ready non-empty media index are all present.

`STREMIO_RUNTIME_ENABLED` remains only as an upgrade-compatibility fallback for older installations. If an existing deployment inherited `true`, the Stremio page offers **Manage runtime here**; saving there moves runtime ownership into CAPTAiNFiN platform settings. New deployments should not use the environment flag as their normal runtime control.

Deploying the code does not by itself make Stremio products sale-ready.

## Verification

After deployment, the command must finish with healthy containers and a passing application-level deployment verification. You can rerun the checks manually:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3030/health/ready
docker compose exec -T app npm run verify:deployment
```

The app should remain bound to `127.0.0.1:3030`; the public HTTPS endpoint should continue to be provided by the existing reverse proxy.

## Pre-deploy backups

Upgrade backups are written to the existing mounted backup directory under:

```text
backups/predeploy/captainfin-<timestamp>.pgdump.enc
```

They use the application's authenticated encrypted-backup format and `BACKUP_ENCRYPTION_KEY`; no raw database dump is intentionally left on the host by the deployment helper. Keep the normal encrypted scheduled backup system enabled as the primary backup mechanism; the pre-deploy backup is an additional upgrade safety point.

## Manual fallback sequence

If the deployment helper cannot be used, preserve the same ordering and ensure the backup UID/GID match the owner of the host `backups` directory:

```bash
node scripts/prepare-production-env.js --write
docker compose config
COMPOSE_PARALLEL_LIMIT=1 docker compose --profile recovery build app automation-worker activity-worker backup-worker migrate recovery-tools
docker compose --profile recovery run --rm --no-deps -e BACKUP_DIR=/backups/predeploy recovery-tools npm run db:backup
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps app automation-worker activity-worker backup-worker
docker compose exec -T app npm run verify:deployment
```

The backup command is for an existing installation; a genuinely fresh database has nothing to back up. Never go directly from an older deployment to `docker compose up -d --build app` now that runtime DB isolation is part of the supported architecture.