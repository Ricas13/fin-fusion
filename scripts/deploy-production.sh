#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Start the real deployment as a nohup child. The interactive wrapper only
# follows its log, so an SSH/session disconnect cannot terminate the deployment.
if [[ "${CAPTAINFIN_DEPLOY_DETACHED:-0}" != "1" ]]; then
  mkdir -p logs
  deploy_log="${CAPTAINFIN_DEPLOY_LOG:-$ROOT/logs/deploy-$(date -u +%Y%m%dT%H%M%SZ).log}"
  printf 'Starting SSH-safe CAPTAiNFiN deployment.\n'
  printf 'Persistent log: %s\n' "$deploy_log"
  nohup env CAPTAINFIN_DEPLOY_DETACHED=1 CAPTAINFIN_DEPLOY_LOG="$deploy_log" \
    bash "$0" "$@" >"$deploy_log" 2>&1 < /dev/null &
  deploy_pid=$!
  printf 'Deployment PID: %s\n' "$deploy_pid"
  printf 'If SSH disconnects, reconnect and run: tail -n 200 -f %q\n\n' "$deploy_log"
  if command -v tail >/dev/null 2>&1; then
    tail --pid="$deploy_pid" -n +1 -f "$deploy_log" || true
  fi
  wait "$deploy_pid"
  exit $?
fi

# Keep only one production deployment active at a time. This is particularly
# important after reconnecting to a host where a detached deployment may still run.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$ROOT/.deploy-production.lock"
  flock -n 9 || fail 'another CAPTAiNFiN production deployment is already running'
fi

services_stopped=0
services_recreated=0
migration_started=0
rollback_safe=0
rollback_override=''
previous_deploy_sha=''
previous_app_image=''
previous_automation_image=''
previous_activity_image=''
previous_backup_image=''

cleanup() {
  if [[ -n "$rollback_override" && -f "$rollback_override" ]]; then
    rm -f "$rollback_override" || true
  fi
}

rollback_runtime() {
  local reason="${1:-deployment failure}"
  local allowed=0

  # Before migrations begin the old containers are always safe to resume. Once
  # migrations have started, automatic runtime rollback is only allowed when the
  # deployed-to-current source diff contains no migration changes. Database
  # rollback remains a separate, explicit recovery operation.
  if [[ "$migration_started" == 0 || "$rollback_safe" == 1 ]]; then
    allowed=1
  fi
  if [[ "$allowed" != 1 ]]; then
    printf '\nAutomatic runtime rollback suppressed: database migrations changed in this release.\n' >&2
    printf 'Use the encrypted pre-deploy backup and recovery tooling if database rollback is required.\n' >&2
    return 0
  fi

  if [[ -z "$previous_app_image" || -z "$previous_automation_image" || -z "$previous_activity_image" || -z "$previous_backup_image" ]]; then
    printf '\nAutomatic runtime rollback unavailable: previous service image IDs were not captured.\n' >&2
    return 0
  fi

  rollback_override="$(mktemp /tmp/captainfin-rollback.XXXXXX.yml)"
  chmod 600 "$rollback_override"
  cat >"$rollback_override" <<YAML
services:
  app:
    image: "$previous_app_image"
  automation-worker:
    image: "$previous_automation_image"
  activity-worker:
    image: "$previous_activity_image"
  backup-worker:
    image: "$previous_backup_image"
YAML

  printf '\nAttempting runtime rollback after %s...\n' "$reason" >&2
  docker compose -f docker-compose.yml -f "$rollback_override" up -d --no-deps --no-build --force-recreate \
    app automation-worker activity-worker backup-worker
  printf 'Previous runtime images restored. Database contents were not rolled back.\n' >&2
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$services_stopped" == 1 || "$services_recreated" == 1 ]]; then
    rollback_runtime "deployment exit $rc" || printf 'Automatic runtime rollback attempt failed; manual recovery is required.\n' >&2
  fi
  printf '\nDeployment failed (exit %s). Current service state:\n' "$rc" >&2
  docker compose ps 2>/dev/null || true
  printf '\nRecent service logs:\n' >&2
  docker compose logs --tail=120 app automation-worker activity-worker backup-worker migrate 2>/dev/null || true
  printf '\nPersistent deployment log: %s\n' "${CAPTAINFIN_DEPLOY_LOG:-unknown}" >&2
  exit "$rc"
}
trap on_error ERR
trap cleanup EXIT
trap '' HUP

command -v docker >/dev/null 2>&1 || fail 'docker is required'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'
[[ -f .env ]] || fail '.env is missing; copy .env.example to .env and configure the installation first'

CAPTAINFIN_BUILD_SHA=unknown
CAPTAINFIN_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if command -v git >/dev/null 2>&1 && [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail 'tracked files have local changes; deploy from a clean checkout so rollback remains predictable'
  fi
  CAPTAINFIN_BUILD_SHA="$(git rev-parse HEAD)"
  log "Deploying commit $(git rev-parse --short HEAD)"
fi

log 'Preparing isolated runtime database credentials'
if command -v node >/dev/null 2>&1; then
  node scripts/prepare-production-env.js --write
else
  docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/work" -w /work node:22-alpine node scripts/prepare-production-env.js --write
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

# Capture the currently running release before builds retag Compose images. These
# immutable image IDs make application-only rollback possible without touching
# the database when a release has no migration changes.
if [[ "$existing_database" == 1 ]] && docker inspect steam-fusion >/dev/null 2>&1; then
  previous_app_image="$(docker inspect -f '{{.Image}}' steam-fusion 2>/dev/null || true)"
  previous_automation_image="$(docker inspect -f '{{.Image}}' steam-fusion-automation 2>/dev/null || true)"
  previous_activity_image="$(docker inspect -f '{{.Image}}' steam-fusion-activity 2>/dev/null || true)"
  previous_backup_image="$(docker inspect -f '{{.Image}}' steam-fusion-backup 2>/dev/null || true)"
  previous_deploy_sha="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' steam-fusion 2>/dev/null | sed -n 's/^CAPTAINFIN_BUILD_SHA=//p' | head -1 || true)"

  if command -v git >/dev/null 2>&1 \
     && [[ "$previous_deploy_sha" =~ ^[0-9a-fA-F]{40}$ ]] \
     && git cat-file -e "${previous_deploy_sha}^{commit}" 2>/dev/null \
     && git diff --quiet "$previous_deploy_sha"..HEAD -- db/migrations; then
    rollback_safe=1
    log "Application-only rollback is available to deployed commit ${previous_deploy_sha:0:8} if verification fails"
  elif [[ -n "$previous_deploy_sha" ]]; then
    log 'Automatic application rollback disabled because migration changes are present or the previous deployed commit is unavailable locally'
  fi
fi

# Compose/BuildKit may otherwise build identical service images concurrently.
# Serialising those builds substantially lowers peak RAM/CPU on small VPS hosts.
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"
log "Building the release images conservatively (COMPOSE_PARALLEL_LIMIT=$COMPOSE_PARALLEL_LIMIT)"
docker compose --profile recovery build \
  --build-arg CAPTAINFIN_BUILD_SHA="$CAPTAINFIN_BUILD_SHA" \
  --build-arg CAPTAINFIN_BUILD_TIME="$CAPTAINFIN_BUILD_TIME" \
  app automation-worker activity-worker backup-worker migrate recovery-tools

if [[ "$existing_database" == 1 ]]; then
  mkdir -p backups/predeploy
  [[ -w backups/predeploy ]] || fail 'backups/predeploy is not writable by the deployment user'
  log 'Creating encrypted pre-deploy PostgreSQL backup'
  docker compose --profile recovery run --rm --no-deps -e BACKUP_DIR=/backups/predeploy recovery-tools npm run db:backup

  # Keep the existing containers intact but stopped until the new schema and
  # runtime roles are ready. This removes the old-app/new-schema write race and
  # preserves their image IDs for a safe application-only rollback.
  log 'Draining runtime services before database migration'
  docker compose stop --timeout 45 app automation-worker activity-worker backup-worker
  services_stopped=1
fi

log 'Applying migrations, runtime DB roles and administrator bootstrap'
migration_started=1
docker compose run --rm --no-deps migrate

log 'Recreating long-running services only after migration/role bootstrap succeeded'
docker compose up -d --no-deps app automation-worker activity-worker backup-worker
services_recreated=1

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

services_stopped=0
services_recreated=0
log 'Deployment complete'
docker compose ps
printf '\nCAPTAiNFiN is running from commit %s.\n' "${CAPTAINFIN_BUILD_SHA:0:8}"
printf 'Deployment log: %s\n' "${CAPTAINFIN_DEPLOY_LOG:-unknown}"
