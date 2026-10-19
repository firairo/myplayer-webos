#!/usr/bin/env bash
#
# Полная установка MyPlayer на LG webOS TV через root/SSH, без Developer Mode.
#
# Делает две независимые вещи:
#   1) Собирает и ставит сам webOS-app (frontend/) как обычно — через ipk.
#   2) Заливает tv-service/service.js на TV и запускает его как обычный
#      Node-процесс (в обход официального механизма webOS JS-сервисов,
#      который на этой прошивке не поднимался). Плюс кладёт автозапуск
#      через хук Homebrew Channel (/var/lib/webosbrew/init.d), чтобы
#      сервис поднимался и после перезагрузки TV.
#
# Использование:
#   ./install-root.sh 192.168.0.144
#   ./install-root.sh 192.168.0.144 alpine   # если пароль root известен заранее

set -euo pipefail

TV_IP="${1:-192.168.0.144}"
TV_PASS="${2:-}"
APP_ID="com.example.vlcwebos"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_IPK="/tmp/${APP_ID}.ipk"
REMOTE_SERVICE_DIR="/home/root/vlcwebos-service"
INIT_HOOK="/var/lib/webosbrew/init.d/50-vlcwebos-service"

c_green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
c_yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
c_red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
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
  local src="$1" dst="$2"
  if [ -n "$TV_PASS" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$TV_PASS" scp -r "${SSH_OPTS[@]}" "$src" "root@$TV_IP:$dst"
  else
    scp -r "${SSH_OPTS[@]}" "$src" "root@$TV_IP:$dst"
  fi
}

# --- 1. ares-cli (нужен только локально, для сборки .ipk приложения) ---
step "Проверяю ares-cli (нужен локально только для сборки .ipk)"
if ! command -v ares-package >/dev/null 2>&1; then
  c_yellow "ares-cli не найден, ставлю глобально через npm..."
  if ! command -v npm >/dev/null 2>&1; then
    c_red "npm не найден. Установите Node.js (https://nodejs.org/) и запустите скрипт снова."
    exit 1
  fi
  npm install -g @webosose/ares-cli
else
  c_green "ares-cli уже установлен."
fi

# --- 2. SSH ---
step "Проверяю SSH-доступ к TV ($TV_IP) как root"
if ! ssh_run "echo ok" 2>/tmp/ssh_err.log | grep -q ok; then
  c_red "Не удалось подключиться по SSH к root@$TV_IP."
  cat /tmp/ssh_err.log >&2 || true
  exit 1
fi
c_green "SSH-доступ подтверждён."

# --- 3. Собираем ipk только из frontend (сервис теперь отдельно, не через webOS-пакет) ---
step "Собираю .ipk приложения (ares-package frontend)"
cd "$PROJECT_DIR"
IPK_OUT=$(ares-package frontend 2>&1 | tee /dev/stderr | grep -oE '[^ ]+\.ipk' | tail -1)
if [ -z "${IPK_OUT:-}" ] || [ ! -f "$IPK_OUT" ]; then
  c_red "Не нашёл .ipk файл в выводе ares-package — смотрите ошибки валидации выше."
  exit 1
fi
c_green "Собран пакет: $IPK_OUT"

# --- 4. Заливаем и ставим приложение ---
step "Копирую .ipk на TV и устанавливаю через luna-send-pub"
scp_run "$IPK_OUT" "$REMOTE_IPK"
ssh_run "luna-send-pub -n 1 -f luna://com.webos.appInstallService/dev/install \
  '{\"id\":\"${APP_ID}\",\"ipkUrl\":\"${REMOTE_IPK}\",\"subscribe\":true}'"
c_green "Приложение установлено."

# --- 5. Заливаем и запускаем локальный Node-сервис (в обход Luna) ---
step "Разворачиваю tv-service на TV ($REMOTE_SERVICE_DIR)"
ssh_run "mkdir -p '$REMOTE_SERVICE_DIR'"
scp_run "$PROJECT_DIR/tv-service/service.js" "$REMOTE_SERVICE_DIR/service.js"
scp_run "$PROJECT_DIR/tv-service/restart-service.sh" "$REMOTE_SERVICE_DIR/restart-service.sh"
ssh_run "chmod +x '$REMOTE_SERVICE_DIR/restart-service.sh'"

step "Ставлю автозапуск сервиса через хук Homebrew Channel"
ssh_run "mkdir -p /var/lib/webosbrew/init.d && cat > '$INIT_HOOK' <<'HOOK'
#!/bin/sh
sh '$REMOTE_SERVICE_DIR/restart-service.sh' >/tmp/vlcwebos-restart.log 2>&1
HOOK
chmod +x '$INIT_HOOK'"

step "Запускаю сервис прямо сейчас (весь вывод ниже — от самого TV)"
ssh_run "sh '$REMOTE_SERVICE_DIR/restart-service.sh'"

# --- 6. Запускаем приложение ---
step "Запускаю приложение на TV"
ssh_run "luna-send-pub -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"${APP_ID}\"}'"

echo
c_green "Готово! MyPlayer должен открыться на экране телевизора."
c_yellow "Лог сервиса (если что-то не так):"
echo "  ssh root@$TV_IP 'cat /tmp/vlcwebos-service.log'"
c_yellow "Быстрая проверка списка накопителей вручную:"
echo "  ssh root@$TV_IP 'curl -s http://127.0.0.1:7788/listDir'"
