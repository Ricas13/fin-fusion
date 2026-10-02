#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/compose-runtime.sh"

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

workers_stopped=0
workers_recreated=0
app_recreated=0
migration_started=0
rollback_safe=0
rollback_override=''
previous_deploy_sha=''
previous_app_image=''
previous_automation_image=''
previous_activity_image=''
previous_backup_image=''
previous_app_container=''
runtime_labels_override=''
candidate_container='captainfin-candidate'
candidate_started=0
candidate_attached=0

cleanup() {
  if [[ -n "$rollback_override" && -f "$rollback_override" ]]; then
    rm -f "$rollback_override" || true
  fi
}

rollback_runtime() {
  local reason="${1:-deployment failure}"
  local allowed=0

  # Before migrations begin the previous runtime is always safe to resume.
  # After migrations begin, rollback is allowed only after either source
  # comparison proved no schema change or the still-running previous web
  # application proved the migrated schema remains N-1 compatible in production.
  if [[ "$migration_started" == 0 || "$rollback_safe" == 1 ]]; then
    allowed=1
  fi
  if [[ "$allowed" != 1 ]]; then
    printf '\nAutomatic runtime rollback suppressed: migrated schema compatibility with the previous runtime was not proven.\n' >&2
    printf 'The existing web container was never intentionally stopped; use the encrypted pre-deploy backup and recovery tooling if database recovery is required.\n' >&2
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
  rollback_services=(automation-worker activity-worker backup-worker)
  if [[ "$app_recreated" == 1 ]]; then
    rollback_services=(app "${rollback_services[@]}")
  fi
  docker compose -f docker-compose.yml -f "$rollback_override" up -d --no-deps --no-build --force-recreate \
    "${rollback_services[@]}"
  if [[ "$app_recreated" == 1 ]]; then
    printf 'Previous web and worker images restored. Database contents were not rolled back.\n' >&2
  else
    printf 'Previous worker images restored; the previous web application remained serving throughout. Database contents were not rolled back.\n' >&2
  fi
}

on_error() {
  local rc=$?
  trap - ERR
  if [[ "$workers_stopped" == 1 || "$workers_recreated" == 1 || "$app_recreated" == 1 ]]; then
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

# Every application/worker/operator service in this deployment uses one
# immutable image tag. The stable captainfin:current alias is advanced only
# after live verification succeeds.
export CAPTAINFIN_IMAGE="captainfin:${CAPTAINFIN_BUILD_SHA}"

log 'Preparing isolated runtime database credentials'
if command -v node >/dev/null 2>&1; then
  node scripts/prepare-production-env.js --write
else
  docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/work" -w /work node:22-alpine node scripts/prepare-production-env.js --write
fi

log 'Validating Compose configuration'
docker compose config >/dev/null

# Runtime container names were historically steam-fusion*. Adopt those
# containers in place before deployment so upgrades keep the same volumes,
# networks and running state while exposing the CAPTAiNFiN runtime identity.
adopt_legacy_container() {
  local canonical="$1"
  local legacy="$2"
  local canonical_exists=0
  local legacy_exists=0
  docker inspect "$canonical" >/dev/null 2>&1 && canonical_exists=1 || true
  docker inspect "$legacy" >/dev/null 2>&1 && legacy_exists=1 || true
  if [[ "$canonical_exists" == 1 && "$legacy_exists" == 1 ]]; then
    fail "both canonical container $canonical and legacy container $legacy exist; resolve the duplicate before deployment"
  fi
  if [[ "$canonical_exists" == 0 && "$legacy_exists" == 1 ]]; then
    log "Adopting legacy runtime container $legacy as $canonical"
    docker rename "$legacy" "$canonical"
  fi
}

adopt_legacy_container captainfin steam-fusion
adopt_legacy_container captainfin-automation steam-fusion-automation
adopt_legacy_container captainfin-activity steam-fusion-activity
adopt_legacy_container captainfin-backup steam-fusion-backup
adopt_legacy_container captainfin-postgres steam-fusion-postgres

existing_database=0
postgres_container="$(compose_service_container postgres)"
if [[ -n "$postgres_container" ]]; then
  existing_database=1
  if [[ "$(compose_service_state postgres)" != 'running' ]]; then
    log 'Starting existing PostgreSQL service container'
    docker start "$postgres_container" >/dev/null
  fi
else
  log 'No existing PostgreSQL service container found; treating this as a fresh installation'
  docker compose up -d postgres
fi

log 'Waiting for PostgreSQL readiness'
for _ in $(seq 1 60); do
  status="$(compose_service_health postgres)"
  [[ "$status" == 'healthy' ]] && break
  sleep 2
done
[[ "$(compose_service_health postgres)" == 'healthy' ]] || fail 'PostgreSQL did not become healthy'

# Capture the currently running release before builds retag Compose images. These
# immutable image IDs make application-only rollback possible without touching
# the database when a release has no migration changes.
if [[ "$existing_database" == 1 && -n "$(compose_service_container app)" ]]; then
  previous_app_image="$(compose_service_image_id app)"
  previous_automation_image="$(compose_service_image_id automation-worker)"
  previous_activity_image="$(compose_service_image_id activity-worker)"
  previous_backup_image="$(compose_service_image_id backup-worker)"
  previous_deploy_sha="$(compose_service_env_value app CAPTAINFIN_BUILD_SHA)"

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
log "Building one immutable release image (COMPOSE_PARALLEL_LIMIT=$COMPOSE_PARALLEL_LIMIT)"
docker compose build \
  --build-arg CAPTAINFIN_BUILD_SHA="$CAPTAINFIN_BUILD_SHA" \
  --build-arg CAPTAINFIN_BUILD_TIME="$CAPTAINFIN_BUILD_TIME" \
  app
docker image inspect "$CAPTAINFIN_IMAGE" >/dev/null 2>&1 || fail "release image was not created: $CAPTAINFIN_IMAGE"

if [[ "$existing_database" == 1 ]]; then
  mkdir -p backups/predeploy
  [[ -w backups/predeploy ]] || fail 'backups/predeploy is not writable by the deployment user'
  log 'Creating encrypted pre-deploy PostgreSQL backup'
  docker compose --profile recovery run --rm --no-deps -e BACKUP_DIR=/backups/predeploy recovery-tools npm run db:backup

  # Keep the customer-facing web application serving while the release is
  # prepared. Mutation-capable background workers are drained before migration,
  # but the portal itself is not stopped merely because a deployment is running.
  log 'Draining background workers before database migration; keeping the current portal live'
  docker compose stop --timeout 45 automation-worker activity-worker backup-worker
  workers_stopped=1
fi

log 'Applying migrations, runtime DB roles and administrator bootstrap'
migration_started=1
docker compose run --rm --no-deps migrate

if [[ "$existing_database" == 1 && -n "$(compose_service_container app)" ]]; then
  log 'Proving the currently serving portal remains healthy on the migrated schema'
  previous_app_ready=0
  for _ in $(seq 1 30); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:3030/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      previous_app_ready=1
      break
    fi
    state="$(compose_service_state app)"
    [[ "$state" == 'exited' || "$state" == 'dead' ]] && break
    sleep 2
  done
  [[ "$previous_app_ready" == 1 ]] || fail 'previous portal readiness probe failed after migration'
  rollback_safe=1
  log 'Previous web runtime is compatible with the migrated schema; rollback remains available'
fi

log 'Starting candidate background workers while the previous portal remains live'
docker compose up -d --no-deps automation-worker activity-worker backup-worker
workers_recreated=1

log 'Waiting for candidate worker health checks'
for service in automation-worker activity-worker backup-worker; do
  ready=0
  for _ in $(seq 1 90); do
    health="$(compose_service_health "$service")"
    if [[ "$health" == 'healthy' || "$health" == 'running' ]]; then
      ready=1
      break
    fi
    [[ "$health" == 'unhealthy' || "$health" == 'exited' || "$health" == 'dead' ]] && break
    sleep 2
  done
  [[ "$ready" == 1 ]] || fail "$service did not become healthy"
  runtime_sha="$(compose_service_env_value "$service" CAPTAINFIN_BUILD_SHA)"
  [[ "$runtime_sha" == "$CAPTAINFIN_BUILD_SHA" ]] || fail "$service is running build ${runtime_sha:-unknown}, expected $CAPTAINFIN_BUILD_SHA"
done

log 'Running candidate deployment verification before touching the live web application'
docker compose run --rm --no-deps app npm run verify:deployment

log 'Candidate verified; switching the customer-facing web application'
docker compose up -d --no-deps app
app_recreated=1

app_ready=0
for _ in $(seq 1 90); do
  health="$(compose_service_health app)"
  if [[ "$health" == 'healthy' || "$health" == 'running' ]]; then
    app_ready=1
    break
  fi
  [[ "$health" == 'unhealthy' || "$health" == 'exited' || "$health" == 'dead' ]] && break
  sleep 2
done
[[ "$app_ready" == 1 ]] || fail 'app did not become healthy after verified cutover'

runtime_sha="$(compose_service_env_value app CAPTAINFIN_BUILD_SHA)"
[[ "$runtime_sha" == "$CAPTAINFIN_BUILD_SHA" ]] || fail "app is running build ${runtime_sha:-unknown}, expected $CAPTAINFIN_BUILD_SHA"

docker compose exec -T app node -e "fetch('http://127.0.0.1:3030/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

log 'Publishing verified runtime alias'
docker image tag "$CAPTAINFIN_IMAGE" captainfin:current

log 'Auditing post-cutover production acceptance'
acceptance_rc=0
docker compose exec -T app npm run verify:production-acceptance || acceptance_rc=$?
if [[ "$acceptance_rc" == 2 ]]; then
  printf '\nProduction acceptance requires operator review. The deployment remains healthy and was not rolled back.\n' >&2
elif [[ "$acceptance_rc" != 0 ]]; then
  fail 'production acceptance audit could not be completed'
fi

workers_stopped=0
workers_recreated=0
app_recreated=0
log 'Deployment complete'
docker compose ps
printf '\nCAPTAiNFiN is running from commit %s.\n' "${CAPTAINFIN_BUILD_SHA:0:8}"
printf 'Deployment log: %s\n' "${CAPTAINFIN_DEPLOY_LOG:-unknown}"
