#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="captainfin-availability-watchdog"
SYSTEMD_DIR="/etc/systemd/system"
RUN_AS_USER="${SUDO_USER:-$(id -un)}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

command -v systemctl >/dev/null 2>&1 || fail 'systemd/systemctl is required for the watchdog installer'
command -v docker >/dev/null 2>&1 || fail 'docker is required'
[[ -x "$ROOT/scripts/availability-watchdog.sh" ]] || chmod +x "$ROOT/scripts/availability-watchdog.sh"

if [[ "$(id -u)" != '0' ]]; then
  command -v sudo >/dev/null 2>&1 || fail 'Run this installer as root or with sudo available.'
  exec sudo -E bash "$0" "$@"
fi

id "$RUN_AS_USER" >/dev/null 2>&1 || fail "Deployment user $RUN_AS_USER does not exist"

log "Installing CAPTAiNFiN availability watchdog for $ROOT"
cat >"$SYSTEMD_DIR/$SERVICE_NAME.service" <<EOF
[Unit]
Description=CAPTAiNFiN availability watchdog
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=$RUN_AS_USER
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/availability-watchdog.sh
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=7

[Install]
WantedBy=multi-user.target
EOF

cat >"$SYSTEMD_DIR/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run CAPTAiNFiN availability watchdog every 30 seconds

[Timer]
OnBootSec=45s
OnUnitActiveSec=30s
AccuracySec=5s
Persistent=true
Unit=$SERVICE_NAME.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"

log 'Availability watchdog installed'
systemctl --no-pager --full status "$SERVICE_NAME.timer" || true
printf '\nWatchdog log: %s/logs/availability-watchdog.log\n' "$ROOT"
printf 'Manual one-shot check: %s/scripts/availability-watchdog.sh\n' "$ROOT"
printf 'Disable: sudo systemctl disable --now %s.timer\n' "$SERVICE_NAME"
