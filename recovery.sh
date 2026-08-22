#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BACKUP_ROOT="$ROOT/backups"
CONFIRMATION="RESTORE_CAPTAINFIN_DATABASE"
RESTORE_ACTIVE=0
SERVICES_STOPPED=0

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
CAPTAiNFiN recovery helper

Usage:
  bash recovery.sh list
  bash recovery.sh check <backup-path>
  bash recovery.sh drill <backup-path>
  RESTORE_CONFIRM=RESTORE_CAPTAINFIN_DATABASE bash recovery.sh restore <backup-path>

Backup paths may be relative to ./backups, for example:
  captainfin-2026-08-22T01-00-00-000Z.pgdump.enc
  backups/predeploy/captainfin-2026-08-22T01-00-00-000Z.pgdump.enc

check   Authenticates/decrypts the backup and asks pg_restore to parse its archive.
drill   Performs check plus a full restore into a temporary verification database.
restore Stops CAPTAiNFiN writers, creates an encrypted pre-restore safety backup,
        restores production, reapplies migrations/runtime roles, restarts services
        and runs deployment verification.

If the current database is too damaged to create the safety snapshot, an emergency
operator may additionally set CAPTAINFIN_RECOVERY_SKIP_SAFETY_BACKUP=1. That flag
is deliberately separate from the required destructive RESTORE_CONFIRM phrase.
EOF
}

on_error() {
  local rc=$?
  if [[ "$RESTORE_ACTIVE" == 1 ]]; then
    printf '\nRecovery failed (exit %s).\n' "$rc" >&2
    if [[ "$SERVICES_STOPPED" == 1 ]]; then
      printf 'CAPTAiNFiN application/workers are intentionally left stopped. Do not restart traffic until the database state is understood.\n' >&2
    fi
    docker compose ps 2>/dev/null || true
  fi
  exit "$rc"
}
trap on_error ERR

require_docker() {
  command -v docker >/dev/null 2>&1 || fail 'docker is required'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'
  [[ -f .env ]] || fail '.env is missing; run this from the CAPTAiNFiN production checkout'
  docker compose config >/dev/null
}

resolve_backup() {
  local raw="${1:-}" host root_real file_real
  [[ -n "$raw" ]] || fail 'a backup path is required'
  raw="${raw#./}"
  raw="${raw#backups/}"
  case "$raw" in
    ''|/*|../*|*/../*|*/..|*'//'*) fail 'backup path must stay inside ./backups' ;;
  esac
  [[ "$raw" == *.pgdump.enc ]] || fail 'backup path must end in .pgdump.enc'
  host="$BACKUP_ROOT/$raw"
  [[ -f "$host" ]] || fail "backup file does not exist: backups/$raw"
  [[ ! -L "$host" ]] || fail 'backup file may not be a symbolic link'
  command -v realpath >/dev/null 2>&1 || fail 'realpath is required'
  root_real="$(realpath "$BACKUP_ROOT")"
  file_real="$(realpath "$host")"
  case "$file_real" in
    "$root_real"/*) ;;
    *) fail 'backup path resolved outside ./backups' ;;
  esac
  BACKUP_REL="$raw"
  BACKUP_HOST="$host"
  BACKUP_CONTAINER="/backups/$raw"
}

wait_postgres() {
  docker compose up -d postgres >/dev/null
  for _ in $(seq 1 60); do
    local health
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' steam-fusion-postgres 2>/dev/null || true)"
    [[ "$health" == 'healthy' ]] && return 0
    [[ "$health" == 'unhealthy' || "$health" == 'exited' || "$health" == 'dead' ]] && break
    sleep 2
  done
  fail 'PostgreSQL did not become healthy'
}

inspect_backup() {
  log "Inspecting encrypted recovery point: backups/$BACKUP_REL"
  docker compose --profile recovery run --rm --no-deps \
    recovery-tools node scripts/inspect-backup.js "$BACKUP_CONTAINER"
}

full_drill() {
  wait_postgres
  log 'Running full temporary-database restore drill'
  # Reuse the backup-worker service definition because it already owns the
  # least-privileged backup metadata role plus the CREATEDB-only verifier role.
  docker compose run --rm --no-deps \
    backup-worker node scripts/verify-backup.js "$BACKUP_CONTAINER"
  printf '\nRecovery drill passed. The production database was not modified.\n'
}

create_pre_restore_safety_backup() {
  if [[ "${CAPTAINFIN_RECOVERY_SKIP_SAFETY_BACKUP:-0}" == '1' ]]; then
    log 'Emergency override: skipping pre-restore safety backup'
    printf 'WARNING: the current production database will not be preserved before replacement.\n' >&2
    return 0
  fi
  log 'Creating encrypted pre-restore safety backup of the current database'
  mkdir -p "$BACKUP_ROOT/pre-restore"
  docker compose --profile recovery run --rm --no-deps \
    -e BACKUP_DIR=/backups/pre-restore \
    recovery-tools node scripts/backup-db.js
  printf 'Current database preserved under backups/pre-restore/.\n'
}

wait_service_health() {
  local container="$1" ready=0 health
  for _ in $(seq 1 90); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    if [[ "$health" == 'healthy' || "$health" == 'running' ]]; then
      ready=1
      break
    fi
    [[ "$health" == 'unhealthy' || "$health" == 'exited' || "$health" == 'dead' ]] && break
    sleep 2
  done
  [[ "$ready" == 1 ]] || fail "$container did not become healthy after recovery"
}

restore_production() {
  [[ "${RESTORE_CONFIRM:-}" == "$CONFIRMATION" ]] || fail "destructive restore refused; set RESTORE_CONFIRM=$CONFIRMATION explicitly"
  RESTORE_ACTIVE=1

  inspect_backup
  wait_postgres

  log 'Stopping CAPTAiNFiN application and worker writers'
  docker compose stop app automation-worker activity-worker backup-worker
  SERVICES_STOPPED=1

  create_pre_restore_safety_backup

  log 'Restoring the selected encrypted backup into production'
  docker compose --profile recovery run --rm --no-deps \
    -e RESTORE_CONFIRM="$CONFIRMATION" \
    recovery-tools node scripts/restore-db.js "$BACKUP_CONTAINER"

  log 'Reapplying migrations, isolated runtime roles and administrator bootstrap'
  docker compose run --rm --no-deps migrate

  log 'Restarting CAPTAiNFiN services'
  docker compose up -d --no-deps app automation-worker activity-worker backup-worker

  for container in steam-fusion steam-fusion-automation steam-fusion-activity steam-fusion-backup; do
    wait_service_health "$container"
  done

  log 'Running application-level deployment verification'
  docker compose exec -T app npm run verify:deployment

  SERVICES_STOPPED=0
  RESTORE_ACTIVE=0
  printf '\nCAPTAiNFiN recovery completed successfully from backups/%s.\n' "$BACKUP_REL"
}

mode="${1:-}"
case "$mode" in
  list)
    mkdir -p "$BACKUP_ROOT"
    printf 'Available CAPTAiNFiN encrypted backups:\n'
    find "$BACKUP_ROOT" -type f -name '*.pgdump.enc' -printf '%TY-%Tm-%Td %TH:%TM  %s bytes  %P\n' 2>/dev/null | sort -r || true
    ;;
  check)
    require_docker
    resolve_backup "${2:-}"
    inspect_backup
    printf '\nRecovery-point check passed. No database was modified.\n'
    ;;
  drill)
    require_docker
    resolve_backup "${2:-}"
    inspect_backup
    full_drill
    ;;
  restore)
    require_docker
    resolve_backup "${2:-}"
    restore_production
    ;;
  -h|--help|help|'') usage ;;
  *) usage; fail "unknown recovery mode: $mode" ;;
esac
