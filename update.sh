#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail 'git is required for bash update.sh'
command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'
[[ -d .git ]] || fail 'This checkout has no .git directory. Update the source manually, then run bash scripts/deploy-production.sh.'
[[ -f .env ]] || fail '.env is missing. Run bash install.sh for a fresh installation.'

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail 'Tracked files have local changes. Commit/stash them before updating so rollback remains predictable.'
fi

branch="$(git branch --show-current)"
[[ "$branch" == 'main' ]] || fail "bash update.sh expects the production checkout to be on main (currently ${branch:-detached})."

log 'Fetching the latest CAPTAiNFiN release from main'
git fetch origin main
git merge --ff-only origin/main

log 'Deploying the updated release'
exec bash scripts/deploy-production.sh
