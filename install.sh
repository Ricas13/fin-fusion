#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env 2>/dev/null | tail -n 1
}

run_node() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
  else
    docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/work" -w /work node:22-alpine node "$@"
  fi
}

command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required. Install Docker first, then rerun bash install.sh.'
docker info >/dev/null 2>&1 || fail 'Docker is installed but the daemon is not available to this user.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
[[ -f .env.example ]] || fail '.env.example is missing from this checkout.'
[[ -f docker-compose.yml ]] || fail 'docker-compose.yml is missing from this checkout.'
[[ -f scripts/deploy-production.sh ]] || fail 'scripts/deploy-production.sh is missing from this checkout.'

printf '\nCAPTAiNFiN installer\n'
printf '===================\n'
printf 'This installer keeps the application private on 127.0.0.1:3030 and uses the existing production deployment safety path.\n'

if [[ ! -f .env ]]; then
  log 'Creating secure installation configuration'
  run_node scripts/prepare-install-env.js --output=.env --template=.env.example
else
  log 'Existing .env detected; preserving all installation secrets'
  printf 'No keys or credentials will be regenerated. The deployment preflight will validate the existing configuration.\n'
fi

mkdir -p backups logs
chmod 700 backups logs 2>/dev/null || true

backup_uid="$(env_value BACKUP_PUID)"
backup_gid="$(env_value BACKUP_PGID)"
[[ "$backup_uid" =~ ^[0-9]+$ ]] || backup_uid=1000
[[ "$backup_gid" =~ ^[0-9]+$ ]] || backup_gid=1000

if [[ "$(id -u)" == '0' ]]; then
  chown "$backup_uid:$backup_gid" backups
else
  if [[ "$backup_uid" != "$(id -u)" || "$backup_gid" != "$(id -g)" ]]; then
    fail "BACKUP_PUID/BACKUP_PGID are ${backup_uid}:${backup_gid}, but this installer is running as $(id -u):$(id -g). Run it as the configured deployment account or correct those values before continuing."
  fi
fi

log 'Starting the supported production deployment'
bash scripts/deploy-production.sh

log 'Installation complete'
printf 'CAPTAiNFiN is listening on 127.0.0.1:3030. Keep that private and publish it through an HTTPS reverse proxy for normal use.\n'
printf 'Future updates are one command from this checkout: bash update.sh\n'

admin_username="$(env_value ADMIN_USERNAME)"
admin_password="$(env_value ADMIN_PASSWORD)"
if [[ -z "$admin_username" && -z "$admin_password" ]]; then
  printf '\nCreate your first administrator\n'
  printf '%s\n' '-------------------------------'
  printf 'Open your HTTPS CAPTAiNFiN address. /login will send you to the secure first-run setup.\n'
  printf 'Use this one-time installation claim code:\n\n'
  if ! docker compose exec -T app npm run setup:claim; then
    printf '\nThe application is healthy, but a claim code could not be printed automatically. Run:\n'
    printf '  docker compose exec app npm run setup:claim\n'
  fi
else
  printf '\nAn unattended administrator is configured in .env; browser first-run claiming is not required.\n'
fi
