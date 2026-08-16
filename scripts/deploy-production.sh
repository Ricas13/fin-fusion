#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

on_error() {
  local rc=$?
  printf '\nDeployment failed (exit %s). Current service state:\n' "$rc" >&2
  docker compose ps 2>/dev/null || true
  printf '\nRecent service logs:\n' >&2
  docker compose logs --tail=120 app automation-worker activity-worker backup-worker migrate 2>/dev/null || true
  exit "$rc"
}
trap on_error ERR

command -v docker >/dev/null 2>&1 || fail 'docker is required'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'
[[ -f .env ]] || fail '.env is missing; copy .env.example to .env and configure the installation first'

if command -v git >/dev/null 2>&1 && [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail 'tracked files have local changes; deploy from a clean checkout so rollback remains predictable'
  fi
  log "Deploying commit $(git rev-parse --short HEAD)"
fi

log 'Preparing isolated runtime database credentials'
if command -v node >/dev/null 2>&1; then
  node scripts/prepare-production-env.js --write
else
  docker run --rm -v "$ROOT:/work" -w /work node:22-alpine node scripts/prepare-production-env.js --write
fi

log 'Validating Compose configuration'
docker compose config >/dev/null

existing_database=0
if docker inspect steam-fusion-postgres >/dev/null 2>&1; then
  existing_database=1
  if [[ "$(docker inspect -f '{{.State.Running}}' steam-fusion-postgres)" != 'true' ]]; then
    log 'Starting existing PostgreSQL container'
    docker start steam-fusion-postgres >/dev/null
  fi
else
  log 'No existing PostgreSQL container found; treating this as a fresh installation'
  docker compose up -d postgres
fi

log 'Waiting for PostgreSQL readiness'
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' steam-fusion-postgres 2>/dev/null || true)"
  [[ "$status" == 'healthy' ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' steam-fusion-postgres 2>/dev/null || true)" == 'healthy' ]] || fail 'PostgreSQL did not become healthy'

log 'Building the release images while the current portal remains online'
docker compose --profile recovery build app automation-worker activity-worker backup-worker migrate recovery-tools

if [[ "$existing_database" == 1 ]]; then
  log 'Creating encrypted pre-deploy PostgreSQL backup'
  docker compose --profile recovery run --rm --no-deps -e BACKUP_DIR=/backups/predeploy recovery-tools npm run db:backup
fi

log 'Applying migrations, runtime DB roles and administrator bootstrap'
docker compose run --rm --no-deps migrate

log 'Recreating long-running services only after migration/role bootstrap succeeded'
docker compose up -d --no-deps app automation-worker activity-worker backup-worker

log 'Waiting for application and worker health checks'
services=(steam-fusion steam-fusion-automation steam-fusion-activity steam-fusion-backup)
for container in "${services[@]}"; do
  ready=0
  for _ in $(seq 1 90); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    if [[ "$health" == 'healthy' || "$health" == 'running' ]]; then
      ready=1
      break
    fi
    [[ "$health" == 'unhealthy' || "$health" == 'exited' || "$health" == 'dead' ]] && break
    sleep 2
  done
  [[ "$ready" == 1 ]] || fail "$container did not become healthy"
done

log 'Running application-level deployment verification'
docker compose exec -T app npm run verify:deployment

log 'Deployment complete'
docker compose ps
printf '\nCAPTaINFiN is running from commit %s.\n' "$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
