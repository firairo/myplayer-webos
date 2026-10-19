#!/usr/bin/env bash
#
# Автоматическая установка MyPlayer на LG webOS TV (через Developer Mode + ares-cli).
#
# Использование:
#   ./install.sh                      # использует IP по умолчанию (192.168.0.144)
#   ./install.sh 192.168.0.99         # свой IP
#   ./install.sh 192.168.0.144 123456 # IP + passphrase из Developer Mode на TV
#
# Запускать из корня проекта (там, где лежат папки frontend/ и services/).

set -euo pipefail

TV_IP="${1:-192.168.0.144}"
PASSPHRASE="${2:-}"
DEVICE_NAME="mytv"
APP_ID="com.example.vlcwebos"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
c_yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
c_red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
step() { echo; c_yellow "==> $1"; }

# --- 1. Проверяем/ставим ares-cli ---
step "Проверяю webOS CLI (ares-cli)"
if ! command -v ares-setup-device >/dev/null 2>&1; then
  c_yellow "ares-cli не найден, ставлю глобально через npm..."
  if ! command -v npm >/dev/null 2>&1; then
    c_red "npm не найден. Установите Node.js (https://nodejs.org/) и запустите скрипт снова."
    exit 1
  fi
  npm install -g @webosose/ares-cli
else
  c_green "ares-cli уже установлен: $(ares-setup-device --version 2>/dev/null || echo ok)"
fi

# --- 2. Проверяем, доступен ли TV по сети ---
step "Проверяю доступность TV по адресу $TV_IP"
if command -v ping >/dev/null 2>&1; then
  if ! ping -c 1 -W 2 "$TV_IP" >/dev/null 2>&1; then
    c_red "TV с адресом $TV_IP не отвечает на ping."
    c_red "Проверьте: TV включён, в той же сети, что и этот компьютер, IP не поменялся."
    exit 1
  fi
  c_green "TV отвечает."
else
  c_yellow "Команда ping недоступна в этой системе — пропускаю проверку, продолжаю."
fi

# --- 3. Настраиваем устройство в ares-cli (если ещё не настроено) ---
step "Настраиваю связь ares-cli <-> TV"
if ares-setup-device --list 2>/dev/null | grep -q "^${DEVICE_NAME}\b"; then
  c_green "Устройство '$DEVICE_NAME' уже настроено в ares-cli, пропускаю ares-setup-device."
else
  c_yellow "Устройство ещё не настроено."
  c_yellow "На TV откройте приложение Developer Mode и нажмите 'Enable Key Server' —"
  c_yellow "на экране появится 6-значный passphrase."

  if [ -z "$PASSPHRASE" ]; then
    read -r -p "Введите passphrase с экрана TV: " PASSPHRASE
  fi

  ares-setup-device -a "$DEVICE_NAME" \
    -i "host=$TV_IP" \
    -i "port=9922" \
    -i "username=prisoner" \
    -i "passphrase=$PASSPHRASE"
fi

# --- 4. Проверяем связь ---
step "Проверяю связь с TV через ares-install"
if ! ares-install -d "$DEVICE_NAME" --list >/dev/null 2>&1; then
  c_red "Не удалось подключиться к TV через ares-cli."
  c_red "Возможные причины: неверный passphrase, TV не в Developer Mode,"
  c_red "фаервол блокирует порт 9922, IP изменился."
  exit 1
fi
c_green "Связь с TV установлена."

# --- 5. Собираем ipk (frontend + services как отдельные директории) ---
step "Собираю .ipk (ares-package frontend)"
cd "$PROJECT_DIR"
IPK_OUT=$(ares-package frontend 2>&1 | tee /dev/stderr | grep -oE '[^ ]+\.ipk' | tail -1)

if [ -z "${IPK_OUT:-}" ] || [ ! -f "$IPK_OUT" ]; then
  c_red "Не нашёл .ipk файл в выводе ares-package — проверьте лог выше на ошибки валидации."
  exit 1
fi
c_green "Собран пакет: $IPK_OUT"

# --- 6. Устанавливаем и запускаем ---
step "Устанавливаю приложение на TV"
ares-install -d "$DEVICE_NAME" "$IPK_OUT"

step "Запускаю приложение на TV"
ares-launch -d "$DEVICE_NAME" "$APP_ID"

echo
c_green "Готово! MyPlayer должен открыться на экране телевизора."
c_yellow "Если что-то не работает — смотрите логи:"
echo "  ares-log -d $DEVICE_NAME $APP_ID"
