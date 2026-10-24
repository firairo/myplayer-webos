#!/usr/bin/env bash
#
# Быстрое обновление ТОЛЬКО tv-service на TV — без пересборки/переустановки
# самого приложения. Заливает service.js + restart-service.sh и выполняет
# restart-service.sh НА САМОМ TV одной простой командой (без хрупких
# длинных ssh-однострочников с &&/&/; вперемешку).
#
# Использование:
#   ./deploy-service.sh 192.168.0.144
#   ./deploy-service.sh 192.168.0.144 alpine

set -euo pipefail

TV_IP="${1:-192.168.0.144}"
TV_PASS="${2:-}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SERVICE_DIR="/home/root/vlcwebos-service"

c_green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
c_yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
step() { echo; c_yellow "==> $1"; }

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

ssh_run() {
  if [ -n "$TV_PASS" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$TV_PASS" ssh "${SSH_OPTS[@]}" "root@$TV_IP" "$@"
  else
    ssh "${SSH_OPTS[@]}" "root@$TV_IP" "$@"
  fi
}

scp_run() {
  if [ -n "$TV_PASS" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$TV_PASS" scp "${SSH_OPTS[@]}" "$1" "root@$TV_IP:$2"
  else
    scp "${SSH_OPTS[@]}" "$1" "root@$TV_IP:$2"
  fi
}

step "Готовлю папку на TV"
ssh_run "mkdir -p '$REMOTE_SERVICE_DIR'"

step "Копирую service.js и restart-service.sh"
scp_run "$PROJECT_DIR/tv-service/service.js" "$REMOTE_SERVICE_DIR/service.js"
scp_run "$PROJECT_DIR/tv-service/restart-service.sh" "$REMOTE_SERVICE_DIR/restart-service.sh"
ssh_run "chmod +x '$REMOTE_SERVICE_DIR/restart-service.sh'"

# Копируем .env если он существует
if [ -f "$PROJECT_DIR/tv-service/.env" ]; then
  step "Копирую .env"
  scp_run "$PROJECT_DIR/tv-service/.env" "$REMOTE_SERVICE_DIR/.env"
fi

step "Перезапускаю сервис на TV (весь вывод ниже — от самого TV)"
ssh_run "sh '$REMOTE_SERVICE_DIR/restart-service.sh'"
