# MyPlayer — самодельный видеоплеер для LG webOS TV

Медиаплеер в духе VLC: воспроизведение по прямой ссылке/HLS, просмотр
локальных файлов (USB/накопители), и попытка сыграть **любой**
формат/контейнер/кодек за счёт ffmpeg на лету (remux/transcode).

## Архитектура (после отладки — важно прочитать)

Изначально сервис для доступа к файловой системе (список USB-папок,
раздача видео) был сделан как официальный webOS Luna JS-сервис,
пакуемый вместе с приложением в один ipk. На практике, на рутованном TV
без Developer Mode, эта система оказалась ненадёжной для отладки —
сервис не поднимался, а штатных логов/утилит для причины было не
получить без Developer Mode.

**Раз у вас есть root — используем его напрямую**, в обход системы
webOS-сервисов:

- `frontend/` — обычное webOS TV-приложение (веб-часть), ставится как
  ipk через `ares-package`/`luna-send-pub`, как обычно.
- `tv-service/service.js` — обычный Node.js-скрипт, который **не**
  является Luna-сервисом. Он просто копируется на TV по SSH и
  запускается как процесс: `node service.js`, слушает
  `127.0.0.1:7788`. Автозапуск при перезагрузке TV — через штатный хук
  Homebrew Channel: `/var/lib/webosbrew/init.d/50-vlcwebos-service`.
- Фронтенд обращается к сервису просто через `fetch()` на
  `http://127.0.0.1:7788/...` — никакого `PalmServiceBridge`.

Это значительно проще в отладке: если что-то не так, просто
`ssh root@TV`, `cd /home/root/vlcwebos-service && node service.js` — и
сразу видно ошибку в консоли, без танцев вокруг ipk/luna-send.

## Структура проекта

```
webos-vlc-player/
├── frontend/                — webOS TV-приложение (ipk)
│   ├── appinfo.json
│   ├── icon.png / largeIcon.png
│   └── index.html / css / js
├── tv-service/
│   └── service.js           — самостоятельный Node-процесс на TV
├── install-root.sh          — полная установка (root/SSH, без Developer Mode)
├── install.sh                — установка приложения через Developer Mode (без сервиса)
├── deploy-service.sh         — быстрое обновление только сервиса на TV
└── README.md
```

## Установка (ваш случай — root, без Developer Mode)

```bash
./install-root.sh 192.168.0.144
```

Что делает:
1. Собирает `.ipk` только из `frontend/` (`ares-package frontend`).
2. Ставит его на TV через `luna-send-pub … dev/install`.
3. Копирует `tv-service/service.js` на TV в `/home/root/vlcwebos-service/`.
4. Прописывает автозапуск через `/var/lib/webosbrew/init.d/`.
5. Запускает сервис прямо сейчас и проверяет, что он отвечает на
   `/listDir`.
6. Запускает само приложение на TV.

Если правите только `tv-service/service.js` (например, пути `ROOTS`)
и не хотите переустанавливать приложение — используйте:
```bash
./deploy-service.sh 192.168.0.144
```

## Если сервис не видит накопители

1. Проверьте лог: `ssh root@192.168.0.144 'cat /tmp/vlcwebos-service.log'`
2. Проверьте, где реально монтируются USB-диски на вашей прошивке:
   ```bash
   ssh root@192.168.0.144 'mount | grep -i usb; ls -la /tmp/usb 2>/dev/null; ls -la /media 2>/dev/null'
   ```
3. **Вариант А (рекомендуется)**: задайте пути через переменные окружения в `deploy-service.sh`:
   ```bash
   MYPLAYER_ROOTS="/tmp/usb:/media" ./deploy-service.sh 192.168.0.144
   ```
4. **Вариант Б**: поправьте список `ROOTS` в `tv-service/service.js` под то, что
   реально увидели, и перезалейте: `./deploy-service.sh 192.168.0.144`.
5. Проверить сервис напрямую, не через приложение:
   ```bash
   ssh root@192.168.0.144 'curl -s http://127.0.0.1:7788/listDir'
   ```

## Настройка через переменные окружения

Сервис поддерживает настройку через переменные окружения:

- `MYPLAYER_PORT` — порт (по умолчанию 7788)
- `MYPLAYER_FFMPEG` — путь к ffmpeg (по умолчанию `/home/root/bin/ffmpeg`)
- `MYPLAYER_FFPROBE` — путь к ffprobe (по умолчанию `/home/root/bin/ffprobe`)
- `MYPLAYER_ROOTS` — корневые директории для доступа к файлам, через `:` (по умолчанию `/tmp/usb`)
- `MYPLAYER_MAX_WIDTH` — максимальная ширина при транскодировании (по умолчанию 99999)
- `MYPLAYER_FORCE_REENCODE` — принудительно перекодировать 10-бит в 8-бит (по умолчанию false)

**Способ 1 — через .env файл (рекомендуется):**
```bash
cp tv-service/.env.example tv-service/.env
# отредактируйте tv-service/.env под вашу систему
./deploy-service.sh 192.168.0.144
```

**Способ 2 — через переменные окружения при запуске:**
```bash
MYPLAYER_ROOTS="/tmp/usb:/media" MYPLAYER_FFMPEG="/usr/bin/ffmpeg" node service.js
```

## Транскодирование (ffmpeg) — по-прежнему нужно на TV

- Нужен реальный бинарник `ffmpeg`/`ffprobe` на TV — у меня нет
  интернета в песочнице, чтобы скачать и протестировать ARM-сборку под
  вашу архитектуру (`uname -m` на TV покажет `armv7l` или `aarch64`).
  Возьмите статическую сборку под неё, `scp` в `/home/root/bin/`,
  `chmod +x`, и при необходимости поправьте `FFMPEG_PATH`/`FFPROBE_PATH`
  в `tv-service/service.js`.
- Копирование видеопотока (когда кодек и так H.264/H.265) — дёшево по
  CPU. Полный re-encode видео может тормозить на слабом ARM-чипе TV.
- Перемотка в режиме транскода — "виртуальная" (плеер перезапускает
  ffmpeg с новой позиции). Для файлов из "родного" списка (`DIRECT_EXT`
  в `service.js`) перемотка честная и мгновенная.

## Про старую версию (для истории)

Файлы официального webOS Luna-сервиса (`package.json`/`services.json`
с полем `commands`, требование `require('webos-service')`) были
убраны из проекта — сама механика осталась рабочей теоретически, если
у вас будет полноценный Developer Mode для нормальной отладки, но в
вашей текущей ситуации (root, без Developer Mode) вариант с обычным
Node-процессом через SSH оказался практичнее и надёжнее.
