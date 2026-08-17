# Runtime database and secret isolation

CAPTAiNFiN uses one PostgreSQL owner only for schema migration, role maintenance and explicit recovery operations. Long-running containers use separate login roles and receive only the secrets required for their job.

## Runtime identities

| Service | PostgreSQL role | Database capability |
|---|---|---|
| Web application | `steamfusion_app` | Runtime DML across application tables; no DDL/role management |
| Automation worker | `steamfusion_automation` | Lifecycle/provisioning DML; authentication/session tables are explicitly excluded and `app_users` is read-only |
| Activity worker | `steamfusion_activity` | Narrow Jellyfin/activity reads and activity-policy writes |
| Backup worker | `steamfusion_backup` | Read all production data for `pg_dump`; write only backup bookkeeping tables |
| Restore verifier | `steamfusion_backup_verify` | `CREATEDB` for temporary verification databases; no production table grants |
| Migration / recovery | `steamfusion` | Owner credential; never supplied to long-running runtime containers |

The backup worker intentionally has two credentials. The production backup login can read the database but cannot create/drop databases. The restore-verifier login can create temporary databases but cannot read the production schema. Compromise of either capability alone therefore does not expose the full owner privilege set.

## Required `.env` values

The owner values remain:

```text
POSTGRES_PASSWORD=...
DATABASE_URL=postgres://steamfusion:...@postgres:5432/steamfusion
```

Add five unique runtime URLs. Every password must be at least 24 characters, must be different from every other runtime password, and must not reuse the owner password:

```text
APP_DATABASE_URL=postgres://steamfusion_app:...@postgres:5432/steamfusion
AUTOMATION_DATABASE_URL=postgres://steamfusion_automation:...@postgres:5432/steamfusion
ACTIVITY_DATABASE_URL=postgres://steamfusion_activity:...@postgres:5432/steamfusion
BACKUP_DATABASE_URL=postgres://steamfusion_backup:...@postgres:5432/steamfusion
BACKUP_VERIFY_DATABASE_URL=postgres://steamfusion_backup_verify:...@postgres:5432/steamfusion
```

Prefer URL-safe random passwords (hex/base64url). If punctuation is used, percent-encode it inside the URL.

## Deployment ordering

Do not restart the existing runtime containers before the new URLs are present. The safe rollout is:

1. Create the normal pre-deploy database backup.
2. Add the five runtime URLs to `.env` without removing the existing owner URL.
3. Pull/build the release while the current services remain up.
4. Run the one-shot migration service. It applies schema migrations, runs `npm run db:runtime-roles`, then performs the administrator bootstrap.
5. Only after that step succeeds, recreate/start the application and workers.
6. Verify `/health/ready`, worker heartbeats and the deployment verification command.

`db:runtime-roles` is idempotent and rotates each runtime role password to the password in the corresponding URL on every successful migration run.

## Secret scope

The long-running services deliberately do not use `env_file: .env`:

- `app` receives application/session/auth, provider and Jellyfin secrets, but not backup/activity worker secrets or the owner database URL.
- `automation-worker` receives provider/Jellyfin integration secrets required by lifecycle jobs, but not session/auth/backup/activity secrets.
- `activity-worker` receives only its database URL plus the Jellyfin and activity-purpose encryption keys and stream-policy settings.
- `backup-worker` receives only the backup database URLs and backup encryption key.
- `migrate` is one-shot and remains the only normal service that reads the complete `.env` because it must create/rotate roles and bootstrap the installation.
- `recovery-tools` remains an explicit opt-in profile with owner database access.

## Rollback

The database owner credential remains unchanged. If a runtime-role deployment must be rolled back, the previous release can still be started with the owner `DATABASE_URL` after restoring its previous Compose configuration. Do not drop the new runtime roles during rollback; leaving unused non-owner roles in place is safer than changing database ownership during an incident.
