#!/bin/sh
# Живёт на TV в /home/root/vlcwebos-service/. Перезапускает сервис
# надёжно, одним вызовом, без хрупких ssh-однострочников.
cd "$(dirname "$0")"

echo "--- Останавливаю старые копии ---"
pkill -f 'node service.js' 2>/dev/null
sleep 2

echo "--- Запускаю ---"
nohup node service.js </dev/null >/tmp/vlcwebos-service.log 2>&1 &
sleep 2

echo "--- PID ---"
pgrep -f 'node service.js' || echo "НЕ ЗАПУЩЕН"

echo "--- Лог ---"
cat /tmp/vlcwebos-service.log

echo "--- Проверка /listDir ---"
curl -s -m 3 http://127.0.0.1:7788/listDir
echo
