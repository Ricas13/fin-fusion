#!/usr/bin/env bash

# Canonical runtime lookup for shell tooling.
# Resolve physical containers through Compose service identity so branding or
# container_name changes cannot break health, recovery or deployment logic.

compose_service_container() {
  local service="${1:?Compose service is required}"
  docker compose ps --all --quiet "$service" 2>/dev/null | head -n 1
}

compose_service_state() {
  local service="${1:?Compose service is required}" container
  container="$(compose_service_container "$service")"
  [[ -n "$container" ]] || { printf 'missing'; return 0; }
  docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || printf 'missing'
}

compose_service_health() {
  local service="${1:?Compose service is required}" container
  container="$(compose_service_container "$service")"
  [[ -n "$container" ]] || { printf 'missing'; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || printf 'missing'
}

compose_service_image_id() {
  local service="${1:?Compose service is required}" container
  container="$(compose_service_container "$service")"
  [[ -n "$container" ]] || return 0
  docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true
}

compose_service_env_value() {
  local service="${1:?Compose service is required}" key="${2:?Environment key is required}" container
  container="$(compose_service_container "$service")"
  [[ -n "$container" ]] || return 0
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null |
    sed -n "s/^${key}=//p" | head -n 1
}
