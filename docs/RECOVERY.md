# Backup and recovery

CAPTAiNFiN database recovery uses authenticated encrypted PostgreSQL custom-format dumps. The normal backup worker can prove a backup by restoring it into a temporary database and checking that the expected CAPTAiNFiN schema exists.

The browser is intentionally a **status and verification control plane**, not a destructive restore console. Production restore remains a host operation.

## Readiness in Admin

Open **Operations → Backups**.

The page separates three signals:

1. **Scheduled protection** — whether the backup worker is healthy and a successful backup exists inside the expected schedule window.
2. **Latest recovery point** — whether the newest successful backup itself has completed a full temporary-database restore verification.
3. **Last recovery drill** — the most recent backup that has ever passed a full restore test.

This distinction matters: an older verified backup does not make a newer unverified backup proven.

For normal production use, keep both **Enable scheduled backups** and **Prove each new backup with a full temporary restore** enabled.

## Host recovery helper

Run all recovery commands from the production checkout.

List encrypted backups:

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

Back up the production `.env`/secret material separately using an appropriately protected secrets process. Do not store the encryption key beside an exported backup in an unprotected location.

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
