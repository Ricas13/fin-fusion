# Production deployment

This is the supported installation, deployment and upgrade path for the Docker Compose installation.

The important safety rule is: **do not recreate the long-running containers until migrations and runtime database-role bootstrap have completed successfully.** Since the runtime-role isolation work, the application, automation, activity and backup processes use separate PostgreSQL identities rather than the database owner login.

## Fresh installation

For a new host with Docker Engine and Docker Compose v2 installed:

```bash
git clone https://github.com/Ricas13/fin-fusion.git captainfin
cd captainfin
bash install.sh
```

`install.sh` is the supported fresh-install entry point. It checks Docker, creates `.env` only when one does not already exist, generates independent high-entropy owner/encryption/session secrets, prepares the backup bind mount, and then delegates to the same production deployment path used for upgrades.

The generated `.env` is written mode `0600`. The installer never prints database or encryption secrets and never overwrites an existing `.env`. Runtime-role URLs are intentionally delegated to `prepare-production-env.js`, so each long-running service receives a separate generated database password.

If the deployment is interrupted after `.env` has been created, rerun:

```bash
bash install.sh
```

The existing secrets are preserved and validated rather than regenerated.

After a successful interactive installation, `install.sh` prints a fresh one-time claim code. Open the HTTPS CAPTAiNFiN address; `/login` redirects to the secure first-run setup where the first administrator is created. The application itself remains bound to `127.0.0.1:3030`.

## Normal CAPTAiNFiN production update

On a normal production checkout that tracks `main`:

```bash
cd /opt/captainfin-store
bash update.sh
```

`update.sh` refuses tracked local changes, requires the production checkout to be on `main`, fast-forwards from `origin/main`, and then invokes the supported deployment helper below.

If source updates are managed separately, or the deployment is intentionally pinned to another ref, run the lower-level deployment command directly:

```bash
bash scripts/deploy-production.sh
```

The interactive deployment command immediately starts the actual deployment as a detached `nohup` process, writes a persistent log under `logs/deploy-<timestamp>.log`, and follows that log while the SSH session remains connected. If SSH disconnects, the deployment continues. Reconnect and inspect the newest deployment log rather than starting a second run:

```bash
cd /opt/captainfin-store
LATEST="$(ls -1t logs/deploy-*.log | head -1)"
tail -n 200 -f "$LATEST"
```

A deployment lock prevents a second production rollout from starting over an active one.

The deployment command performs the following sequence:

1. Refuses to deploy tracked local source changes.
2. Validates `.env` and generates any missing isolated runtime DB URLs with independent high-entropy passwords.
3. Rejects `.env.example` placeholder database credentials rather than allowing a copied example to become a production secret.
4. Records the deployment user's UID/GID as `BACKUP_PUID`/`BACKUP_PGID` when those values are absent, so bind-mounted encrypted backups are written as the host account that owns `./backups`.
5. Saves the old `.env` before adding generated deployment values.
6. Validates the full Docker Compose configuration.
7. Starts/waits for PostgreSQL without recreating an existing database container.
8. Builds the new images while the currently-running portal remains online. Compose parallelism defaults to `1` to reduce peak memory/CPU pressure on small hosts.
9. Creates an **encrypted** pre-deploy PostgreSQL backup through the existing recovery tooling when this is an upgrade.
10. Runs database migrations, runtime-role creation/password rotation and administrator bootstrap in the one-shot migration container.
11. Recreates the application and worker containers only after that one-shot migration step succeeds.
12. The backup worker immediately retries a persisted failed backup after restart. This clears an old operational failure only after a new encrypted backup/verification succeeds.
13. Waits for Docker health checks on the web app, automation worker, activity worker and backup worker.
14. Runs `npm run verify:deployment` from the live application container. Backup failure state is a deployment blocker, not heartbeat-only success.

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

Each generated URL points at the same PostgreSQL host/database as `DATABASE_URL`, uses the required runtime role name, and gets a unique random password. Existing values are validated rather than silently replaced. Weak, duplicate, owner-reused, example-placeholder or wrong-role credentials fail closed.

The helper also fills these host filesystem identity values when run by a non-root deployment account:

```text
BACKUP_PUID
BACKUP_PGID
```

`backup-worker` and `recovery-tools` run with that numeric identity so a bind mount such as `/opt/captainfin-store/backups -> /backups` remains writable without changing the host directory to world-writable permissions. A fresh root-run `install.sh` deliberately prepares the backup directory for the Compose default non-root identity (`1000:1000`) instead of running the backup container as root.

To prepare/validate the environment without deploying:

```bash
node scripts/prepare-production-env.js --write
node scripts/prepare-production-env.js --check
```

If Node is not installed on the host, `install.sh` and the full production deployment script automatically run their environment helpers through the Node 22 Docker image using the host caller's UID/GID.

## Stremio rollout

Normal external Stremio delivery is configured in the browser from **Servers → Stremio Sources**. No Stremio-specific environment key is required for an external-source-only plan: source Jellyfin session tokens use the existing `JELLYFIN_ENCRYPTION_KEY`, which is already a required production secret.

After deployment:

1. Add a dedicated normal-user Jellyfin account under **Servers → Stremio Sources**.
2. Select the Movie/TV libraries CAPTAiNFiN is allowed to index.
3. Wait for the initial source index to show **Ready**.
4. Enable the Stremio runtime from the same page.
5. Open the Stremio/bundle plan under **Commerce → Plans → Delivery** and explicitly select the allowed source(s).
6. Test with a controlled customer before publishing the product.

External source passwords are never stored. They are used only to obtain a Jellyfin user session, whose token is encrypted with `JELLYFIN_ENCRYPTION_KEY`. Incremental indexing runs every six hours, with a full reconciliation at least every seven days.

`STREMIO_JELLYFIN_TOKEN_KEY` is retained for the legacy CAPTAiNFiN-managed Jellyfin delivery path that creates hidden restricted Jellyfin users. External-source-only plans do not require it. `STREMIO_RUNTIME_ENABLED` remains only as an upgrade-compatibility fallback for installations that have not yet saved the browser-managed runtime setting.

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