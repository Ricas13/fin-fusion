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


# Capture non-Compose labels from the live web container into a temporary
# Compose override. Production-specific metadata must survive app replacement.
compose_capture_runtime_labels() {
  local container="${1:?Container is required}" output="${2:?Output path is required}"
  docker inspect "$container" | node -e '
    const fs=require("fs");
    const output=process.argv[1];
    let input="";
    process.stdin.on("data",chunk=>input+=chunk);
    process.stdin.on("end",()=>{
      const inspected=JSON.parse(input)[0];
      if(!inspected) throw new Error("Container inspect payload is empty.");
      const labels=Object.entries(inspected.Config?.Labels||{})
        .filter(([key])=>!String(key).startsWith("com.docker.compose."))
        .sort(([a],[b])=>a.localeCompare(b));
      const lines=["services:","  app:","    labels:"];
      if(!labels.length) lines.push("      {}");
      else for(const [key,value] of labels){
        lines.push(`      ${JSON.stringify(String(key))}: ${JSON.stringify(String(value))}`);
      }
      fs.writeFileSync(output,lines.join("\n")+"\n");
    });
  ' "$output"
}

container_network_names() {
  local container="${1:?Container is required}"
  docker inspect -f '{{range $name,$cfg := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container" 2>/dev/null |
    sed '/^$/d'
}

# Copy network attachments from a known-live source onto a verified target.
# This lets old and new web generations overlap before the old one is retired.
connect_missing_container_networks() {
  local source="${1:?Source container is required}" target="${2:?Target container is required}"
  local network
  while IFS= read -r network; do
    [[ -n "$network" ]] || continue
    if ! container_network_names "$target" | grep -Fxq "$network"; then
      docker network connect "$network" "$target"
    fi
  done < <(container_network_names "$source")
}

container_http_ready() {
  local container="${1:?Container is required}" path="${2:-/health/ready}"
  docker exec "$container" node -e "fetch('http://127.0.0.1:3030${path}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_container_http_ready() {
  local container="${1:?Container is required}" attempts="${2:-90}" delay="${3:-2}" path="${4:-/health/ready}"
  local state _
  for _ in $(seq 1 "$attempts"); do
    if container_http_ready "$container" "$path"; then return 0; fi
    state="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || printf missing)"
    [[ "$state" == 'exited' || "$state" == 'dead' || "$state" == 'missing' ]] && return 1
    sleep "$delay"
  done
  return 1
}

verify_portal_routes_in_container() {
  local container="${1:?Container is required}"
  docker exec "$container" node -e '
    (async()=>{
      for(const path of ["/","/account/login"]){
        const response=await fetch("http://127.0.0.1:3030"+path,{redirect:"manual"});
        if(response.status!==200) throw new Error(path+" returned HTTP "+response.status);
        const body=await response.text();
        if(!body.toLowerCase().includes("<!doctype html")) throw new Error(path+" did not render HTML");
      }
    })().catch(error=>{console.error(error);process.exit(1);});
  '
}
