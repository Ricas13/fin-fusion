# Backup and recovery

CAPTAiNFiN database recovery uses authenticated encrypted PostgreSQL custom-format dumps. The normal backup worker can prove a backup by restoring it into a temporary database and checking that the expected CAPTAiNFiN schema exists.

The browser is intentionally a **status and verification control plane**, not a destructive restore console. Production restore remains a host operation.

## Readiness in Admin

Open **Operations → Backups**.

The page separates four signals:

1. **Scheduled protection** — whether the backup worker is healthy and a successful backup exists inside the expected schedule window.
2. **Latest recovery point** — whether the newest successful backup itself has completed a full temporary-database restore verification.
3. **Recovery proof** — the most recent restore proof for the newest recovery point.
4. **Host-loss copy** — whether the newest encrypted recovery point has also been copied to the configured off-host destination.

This distinction matters: an older verified backup does not make a newer unverified backup proven, and a healthy local backup does not by itself protect against loss of the production host.

For normal production use, keep both **Enable scheduled backups** and **Automatically verify each new backup** enabled, and configure an off-host destination when host-loss recovery is required.

## Encrypted off-host copies

Off-host copying is optional and disabled by default. It extends the existing backup pipeline; it does not create a second scheduler or a second backup format.

The sequence is deliberately fail-safe:

1. `pg_dump` produces the database stream.
2. CAPTAiNFiN encrypts it locally using the existing authenticated `BACKUP_ENCRYPTION_KEY` format.
3. The completed `.pgdump.enc` file is atomically placed in `BACKUP_DIR` and recorded as a successful local recovery point.
4. Only that already-encrypted file is uploaded to the S3-compatible destination.
5. Remote-copy success or failure is stored separately in the existing backup run metadata.

A remote-copy failure therefore **does not invalidate the local recovery point**. The admin page reports that local recovery succeeded while host-loss protection needs attention.

Supported S3-compatible destinations include AWS S3, Cloudflare R2, Backblaze B2 S3, MinIO and compatible providers. HTTPS is mandatory.

Configure the production `.env`:

```env
BACKUP_OFFSITE_ENABLED=true
BACKUP_OFFSITE_PROVIDER=s3
BACKUP_S3_ENDPOINT=https://your-s3-endpoint.example
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=captainfin-backups
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_SESSION_TOKEN=
BACKUP_S3_PREFIX=captainfin/
BACKUP_S3_FORCE_PATH_STYLE=true
BACKUP_S3_MAX_ATTEMPTS=3
```

For Cloudflare R2, use the R2 S3 endpoint and the provider's required signing region (commonly `auto`). For AWS S3, use the bucket's AWS region. Set `BACKUP_S3_FORCE_PATH_STYLE=false` only when the provider requires virtual-hosted bucket addressing.

The S3 access key, secret and optional session token are passed only to the backup worker and the explicit recovery-tools profile. The normal web application receives only the non-secret enable/provider flags needed to render readiness state.

The destination client uses bounded retries and never logs configured credentials. The browser never receives the endpoint, bucket, access key or secret.

Check the configured destination from the host:

```bash
docker compose --profile recovery run --rm --no-deps recovery-tools \
  node scripts/offsite-backup.js health
```

List off-host encrypted recovery points:

```bash
docker compose --profile recovery run --rm --no-deps recovery-tools \
  node scripts/offsite-backup.js list
```

Upload an existing encrypted local recovery point manually if needed:

```bash
docker compose --profile recovery run --rm --no-deps recovery-tools \
  node scripts/offsite-backup.js put /backups/captainfin-<timestamp>.pgdump.enc
```

Remote deletion is intentionally guarded and is not part of normal local-retention cleanup. It requires a separate destructive confirmation variable:

```bash
BACKUP_OFFSITE_DELETE_CONFIRM=DELETE_ENCRYPTED_BACKUP \
  docker compose --profile recovery run --rm --no-deps recovery-tools \
  node scripts/offsite-backup.js delete 'captainfin/captainfin-<timestamp>.pgdump.enc'
```

## Recover after total host loss

The off-host file is useful only if you also retain the matching `BACKUP_ENCRYPTION_KEY` and the credentials needed to reach the remote backup store **outside the failed host**. Store those secrets in a separate protected secrets/password-management process. Do not put the encryption key in the backup bucket.

On a replacement host:

1. install/clone the same CAPTAiNFiN release;
2. restore the required production secrets, including `BACKUP_ENCRYPTION_KEY` and off-site S3 configuration, into the protected `.env`;
3. create the local `backups/` directory with the normal production ownership;
4. list the remote recovery points;
5. download the chosen encrypted object into `/backups`;
6. run the normal offline check, recovery drill and only then a production restore.

Example remote retrieval:

```bash
docker compose --profile recovery run --rm --no-deps recovery-tools \
  node scripts/offsite-backup.js list

docker compose --profile recovery run --rm --no-deps recovery-tools \
  node scripts/offsite-backup.js get \
  'captainfin/captainfin-<timestamp>.pgdump.enc' \
  '/backups/captainfin-<timestamp>.pgdump.enc'
```

Then continue with the same recovery tooling:

```bash
bash recovery.sh check 'backups/captainfin-<timestamp>.pgdump.enc'
bash recovery.sh drill 'backups/captainfin-<timestamp>.pgdump.enc'
```

A downloaded object is never trusted merely because the S3 request succeeded. The offline check authenticates the encrypted file using the backup key and asks PostgreSQL tooling to parse the archive before it is used for recovery.

## Host recovery helper

Run all recovery commands from the production checkout.

List encrypted local backups:

```bash
bash recovery.sh list
```

### 1. Offline recovery-point check

```bash
bash recovery.sh check 'backups/captainfin-<timestamp>.pgdump.enc'
```

This is non-destructive and does **not** require a working production database. It:

- refuses backup paths outside `./backups`;
- refuses symlink backup files;
- authenticates and decrypts the selected AES-GCM backup using `BACKUP_ENCRYPTION_KEY`;
- writes plaintext only to protected temporary storage inside the recovery container;
- asks `pg_restore --list` to parse the archive;
- checks that the archive contains the expected CAPTAiNFiN structure;
- deletes the temporary plaintext before exiting.

Use this first when the live database is unhealthy or unavailable.

### 2. Full recovery drill

```bash
bash recovery.sh drill 'backups/captainfin-<timestamp>.pgdump.enc'
```

The drill runs the offline check and then uses the existing least-privileged backup/verifier identities to:

1. create a temporary PostgreSQL database;
2. restore the complete selected backup into it;
3. confirm the expected CAPTAiNFiN schema and migration table are present;
4. record the verification result against the managed backup when applicable;
5. delete the temporary database.

The production database is not modified.

Run a drill after meaningful database/configuration changes and before relying on a recovery point for disaster recovery.

## Destructive production restore

Only use this when you intentionally want the selected recovery point to replace the live CAPTAiNFiN database.

```bash
RESTORE_CONFIRM=RESTORE_CAPTAINFIN_DATABASE \
  bash recovery.sh restore 'backups/captainfin-<timestamp>.pgdump.enc'
```

The explicit confirmation phrase is mandatory. The helper then:

1. performs the offline encrypted-backup check;
2. ensures PostgreSQL is healthy enough to receive the restore;
3. stops the web application and all long-running worker writers;
4. creates a new encrypted snapshot of the current database under `backups/pre-restore/`;
5. runs the existing destructive restore tooling with the exclusive maintenance lock;
6. reapplies migrations, isolated runtime database roles and administrator bootstrap;
7. restarts the application and workers;
8. waits for their health checks;
9. runs `npm run verify:deployment` inside the live app container.

The pre-restore snapshot is intentionally created **after application writers are stopped**, so the state being replaced is preserved before the destructive restore begins.

If the current database is too damaged for `pg_dump` to create that safety snapshot, recovery fails closed and leaves the application/workers stopped. An emergency operator who has already accepted the loss of the current database can make that second decision explicitly:

```bash
CAPTAINFIN_RECOVERY_SKIP_SAFETY_BACKUP=1 \
RESTORE_CONFIRM=RESTORE_CAPTAINFIN_DATABASE \
  bash recovery.sh restore 'backups/captainfin-<timestamp>.pgdump.enc'
```

The emergency skip flag is separate from the destructive confirmation phrase so a normal restore cannot silently omit the safety snapshot.

If recovery fails after application writers are stopped, the helper deliberately **leaves them stopped**. Do not restart traffic until the database state is understood and either the restore is completed or another known-good recovery point is selected.

## Encryption-key warning

`BACKUP_ENCRYPTION_KEY` is required to authenticate/decrypt every CAPTAiNFiN encrypted database backup. A backup file without the matching key is intentionally unrecoverable.

Back up the production `.env`/secret material separately using an appropriately protected secrets process. Do not store the encryption key beside an exported backup in an unprotected location, and do not store it in the same S3 bucket as the encrypted database copies.

## Pre-deploy and pre-restore recovery points

Normal upgrades create encrypted recovery points under:

```text
backups/predeploy/
```

A destructive recovery normally preserves the replaced database under:

```text
backups/pre-restore/
```

Both use the same authenticated encrypted format and can be passed to `recovery.sh check`, `drill`, or `restore` using their path under `backups/`.

Scheduled managed backups remain the primary protection mechanism; pre-deploy and pre-restore backups are additional safety points around high-impact operations.
