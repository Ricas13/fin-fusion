#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR="${CAPTAINFIN_WATCHDOG_STATE_DIR:-$ROOT/.runtime/availability-watchdog}"
LOG_DIR="${CAPTAINFIN_WATCHDOG_LOG_DIR:-$ROOT/logs}"
PORT="${PORT:-3030}"
BASE_URL="${CAPTAINFIN_WATCHDOG_URL:-http://127.0.0.1:${PORT}}"
FAILURE_THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-3}"
CURL_TIMEOUT="${WATCHDOG_CURL_TIMEOUT_SECONDS:-4}"
RESTART_COOLDOWN="${WATCHDOG_RESTART_COOLDOWN_SECONDS:-300}"
POST_RESTART_WAIT="${WATCHDOG_POST_RESTART_WAIT_SECONDS:-12}"

mkdir -p "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
LOG_FILE="$LOG_DIR/availability-watchdog.log"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
}

number_or_default() {
  local value="$1" fallback="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && printf '%s' "$value" || printf '%s' "$fallback"
}
FAILURE_THRESHOLD="$(number_or_default "$FAILURE_THRESHOLD" 3)"
CURL_TIMEOUT="$(number_or_default "$CURL_TIMEOUT" 4)"
RESTART_COOLDOWN="$(number_or_default "$RESTART_COOLDOWN" 300)"
POST_RESTART_WAIT="$(number_or_default "$POST_RESTART_WAIT" 12)"
(( FAILURE_THRESHOLD >= 1 )) || FAILURE_THRESHOLD=1
(( CURL_TIMEOUT >= 1 )) || CURL_TIMEOUT=1
(( RESTART_COOLDOWN >= 30 )) || RESTART_COOLDOWN=30

if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/watchdog.lock"
  flock -n 9 || exit 0
fi

read_int() {
  local file="$1"
  local value=0
  [[ -f "$file" ]] && value="$(cat "$file" 2>/dev/null || printf 0)"
  [[ "$value" =~ ^[0-9]+$ ]] || value=0
  printf '%s' "$value"
}

write_int() {
  printf '%s\n' "$2" >"$1"
}

increment() {
  local file="$1" value
  value="$(read_int "$file")"
  value=$((value + 1))
  write_int "$file" "$value"
  printf '%s' "$value"
}

reset_counter() {
  write_int "$1" 0
}

cooldown_allows_restart() {
  local file="$STATE_DIR/last-restart-epoch" now last
  now="$(date +%s)"
  last="$(read_int "$file")"
  (( now - last >= RESTART_COOLDOWN ))
}

mark_restart() {
  write_int "$STATE_DIR/last-restart-epoch" "$(date +%s)"
}

http_ok() {
  curl -fsS --max-time "$CURL_TIMEOUT" "$1" >/dev/null 2>&1
}

container_state() {
  docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || printf 'missing'
}

container_health() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || printf 'missing'
}

wait_for_postgres() {
  local health
  for _ in $(seq 1 30); do
    health="$(container_health steam-fusion-postgres)"
    [[ "$health" == 'healthy' ]] && return 0
    sleep 2
  done
  return 1
}

recover_app() {
  local reason="$1"
  if ! cooldown_allows_restart; then
    log "Web recovery suppressed by restart cooldown (${reason})."
    return 1
  fi

  mark_restart
  log "Recovering customer web app: ${reason}."
  if ! docker compose restart app >>"$LOG_FILE" 2>&1; then
    log 'docker compose restart app failed; forcing the current app service definition back up.'
    docker compose up -d --no-deps --force-recreate app >>"$LOG_FILE" 2>&1 || return 1
  fi
  sleep "$POST_RESTART_WAIT"
  if http_ok "$BASE_URL/health/ready"; then
    reset_counter "$STATE_DIR/live-failures"
    reset_counter "$STATE_DIR/ready-failures"
    log 'Customer web app recovered and is ready.'
    return 0
  fi
  log 'Customer web app is still not ready after recovery attempt.'
  return 1
}

# If the web container is absent/exited/dead, do not wait for an HTTP failure
# threshold: Compose/Docker restart policy should normally recover it, but the
# watchdog provides a second independent path.
app_state="$(container_state steam-fusion)"
if [[ "$app_state" != 'running' ]]; then
  failures="$(increment "$STATE_DIR/live-failures")"
  log "Web container state=${app_state}; recovery count=${failures}."
  if cooldown_allows_restart; then
    mark_restart
    docker compose up -d --no-deps app >>"$LOG_FILE" 2>&1 || true
    sleep "$POST_RESTART_WAIT"
  fi
  exit 0
fi

# /health/live is intentionally database-independent. Failure here means the
# Node process/event loop or the local HTTP path is unhealthy.
if ! http_ok "$BASE_URL/health/live"; then
  failures="$(increment "$STATE_DIR/live-failures")"
  log "Liveness probe failed (${failures}/${FAILURE_THRESHOLD})."
  if (( failures >= FAILURE_THRESHOLD )); then
    recover_app 'liveness failed repeatedly' || true
  fi
  exit 0
fi
reset_counter "$STATE_DIR/live-failures"

# Readiness includes the application database path. A readiness failure with a
# dead PostgreSQL container gets a safe container restart. A *running* but
# unhealthy PostgreSQL instance is deliberately NOT restarted automatically:
# repeated DB restarts during storage/corruption/recovery problems can make a
# recoverable incident worse.
if http_ok "$BASE_URL/health/ready"; then
  reset_counter "$STATE_DIR/ready-failures"
  exit 0
fi

ready_failures="$(increment "$STATE_DIR/ready-failures")"
postgres_state="$(container_state steam-fusion-postgres)"
postgres_health="$(container_health steam-fusion-postgres)"
log "Readiness probe failed (${ready_failures}/${FAILURE_THRESHOLD}); postgres=${postgres_state}/${postgres_health}."

if [[ "$postgres_state" != 'running' ]]; then
  log 'PostgreSQL container is not running; asking Compose to start the existing database container/volume.'
  docker compose up -d postgres >>"$LOG_FILE" 2>&1 || exit 0
  if wait_for_postgres; then
    log 'PostgreSQL recovered; recycling web app so its pool reconnects cleanly.'
    recover_app 'PostgreSQL recovered after being stopped' || true
  else
    log 'PostgreSQL did not become healthy; preserving state for operator diagnosis.'
  fi
  exit 0
fi

if [[ "$postgres_health" != 'healthy' ]]; then
  log 'PostgreSQL is running but unhealthy; refusing automatic DB restart to avoid a destructive restart loop.'
  exit 0
fi

# Non-critical maintenance is allowed to lose before storefront availability.
# If backup itself is unhealthy while the web app cannot become ready, stop it
# first and give PostgreSQL/storage pressure a chance to clear.
backup_health="$(container_health steam-fusion-backup)"
if [[ "$backup_health" == 'unhealthy' ]]; then
  log 'Backup worker is unhealthy during a storefront readiness incident; stopping backup-worker as an availability circuit breaker.'
  docker compose stop backup-worker >>"$LOG_FILE" 2>&1 || true
  sleep 8
  if http_ok "$BASE_URL/health/ready"; then
    reset_counter "$STATE_DIR/ready-failures"
    log 'Storefront recovered after isolating backup-worker. Backup remains stopped for operator review.'
    exit 0
  fi
fi

if (( ready_failures >= FAILURE_THRESHOLD )); then
  recover_app 'readiness failed repeatedly while PostgreSQL remained healthy' || true
fi
