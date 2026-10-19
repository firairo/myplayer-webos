'use strict';

/**
 * Сервис MyPlayer.
 *
 *  Luna-методы:
 *    listDir           — список файлов/папок (для браузера накопителей)
 *
 *  HTTP (127.0.0.1:PORT):
 *    GET /probe?path=...            — данные о файле (кодеки, длительность,
 *                                     можно ли отдавать напрямую или нужен транскод)
 *    GET /stream?path=...&start=N   — сама раздача:
 *        - "родные" контейнеры (mp4/m4v/mov/webm) отдаются как есть,
 *          с поддержкой Range (перемотка бесплатна по CPU)
 *        - всё остальное (mkv/avi/flv/wmv/ts/любое аудио и т.д.)
 *          перепаковывается/перекодируется на лету через ffmpeg и льётся
 *          потоком. У такого потока нет Content-Length, поэтому
 *          перемотка эмулируется параметром start=<секунды> — фронтенд
 *          при перемотке просто переоткрывает поток с новой стартовой
 *          позиции (см. js/player.js, режим "transcode").
 *
 * Требует: пакет "webos-service" (npm install) + бинарники ffmpeg/ffprobe
 * на самом TV (см. README.md — как раздобыть статическую сборку под ARM
 * и куда положить).
 */

const Service = require('webos-service');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn, execFileSync } = require('child_process');

const SERVICE_ID = 'com.example.vlcwebos.service';
const PORT = 7788;

// Пути к бинарникам ffmpeg/ffprobe на TV. Поправьте под свою установку
// (см. README.md — раздел про ffmpeg).
const FFMPEG_PATH = '/home/root/bin/ffmpeg';
const FFPROBE_PATH = '/home/root/bin/ffprobe';

// Куда обычно монтируются накопители на webOS TV.
const ROOTS = [
  '/media/developer/usb',
  '/tmp/usb',
  '/media',
  '/run/media',
  '/mnt'
];

// Контейнеры, которые нативный <video> в webOS понимает без танцев с бубном.
// Всё, чего нет в этом списке, идёт через ffmpeg (remux/transcode).
const DIRECT_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);

// Кодеки, которые не нужно перекодировать повторно (копируем как есть —
// дёшево по CPU). Всё остальное реально перекодируется в h264/aac.
const NATIVE_VIDEO_CODECS = new Set(['h264', 'hevc']);
const NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3']);

function mimeFor(ext) {
  switch (ext) {
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.srt': return 'text/plain';
    case '.vtt': return 'text/vtt';
    default: return 'application/octet-stream';
  }
}

function isHiddenName(name) {
  return name.startsWith('.');
}

function safeReaddir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => !isHiddenName(d.name))
      .map((d) => ({
        name: d.name,
        isDir: d.isDirectory(),
        path: path.join(dirPath, d.name)
      }))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  } catch (e) {
    return [];
  }
}

/** Дёргаем ffprobe и возвращаем разобранную информацию о файле. */
function probeFile(filePath) {
  const raw = execFileSync(FFPROBE_PATH, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { maxBuffer: 10 * 1024 * 1024 }).toString();

  const data = JSON.parse(raw);
  const vStream = (data.streams || []).find((s) => s.codec_type === 'video');
  const aStream = (data.streams || []).find((s) => s.codec_type === 'audio');
  const duration = parseFloat((data.format && data.format.duration) || vStream?.duration || aStream?.duration || 0);

  return {
    duration: isFinite(duration) ? duration : 0,
    hasVideo: !!vStream,
    hasAudio: !!aStream,
    vcodec: vStream ? vStream.codec_name : null,
    acodec: aStream ? aStream.codec_name : null
  };
}

function isDirectPlayable(filePath, info) {
  const ext = path.extname(filePath).toLowerCase();
  if (!DIRECT_EXT.has(ext)) return false;
  if (info.hasVideo && !NATIVE_VIDEO_CODECS.has(info.vcodec)) return false;
  if (info.hasAudio && !NATIVE_AUDIO_CODECS.has(info.acodec)) return false;
  return true;
}

const service = new Service(SERVICE_ID);

service.register('listDir', function (message) {
  const reqPath = message.payload && message.payload.path;

  if (!reqPath) {
    const roots = ROOTS
      .filter((r) => fs.existsSync(r))
      .map((r) => ({ name: r, isDir: true, path: r }));
    message.respond({ returnValue: true, entries: roots });
    return;
  }

  message.respond({ returnValue: true, entries: safeReaddir(reqPath) });
});

// --- HTTP: /probe и /stream ---
http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const filePath = parsed.query.path;

  if (!filePath) {
    res.writeHead(400); res.end('Missing path'); return;
  }

  if (parsed.pathname === '/probe') {
    // filePath может быть и локальным путём, и http(s)-ссылкой — ffprobe ест и то и другое
    try {
      const info = probeFile(filePath);
      info.direct = fs.existsSync(filePath) ? isDirectPlayable(filePath, info) : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, duration: 0, hasVideo: true, hasAudio: true, direct: false }));
    }
    return;
  }

  if (parsed.pathname === '/stream') {
    const startSec = parseFloat(parsed.query.start || '0') || 0;
    const localFile = fs.existsSync(filePath);

    let direct = false;
    let info = null;
    try {
      info = probeFile(filePath);
      direct = localFile && isDirectPlayable(filePath, info) && !parsed.query.start;
    } catch (e) {
      direct = false;
    }

    if (direct) {
      // --- Быстрый путь: раздаём файл как есть, с поддержкой Range (перемотка бесплатна) ---
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeFor(ext);
      const range = req.headers.range;

      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Type': contentType
        });
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }

    // --- Медленный путь: remux/transcode на лету через ffmpeg ---
    const vArgs = (info && info.hasVideo)
      ? (NATIVE_VIDEO_CODECS.has(info.vcodec) ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-vf', 'scale=\'min(1920,iw)\':-2'])
      : ['-vn'];
    const aArgs = (!info || info.hasAudio !== false)
      ? (info && NATIVE_AUDIO_CODECS.has(info.acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])
      : ['-an'];

    const args = [
      ...(startSec > 0 ? ['-ss', String(startSec)] : []),
      '-i', filePath,
      ...vArgs,
      ...aArgs,
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+faststart+default_base_moof',
      'pipe:1'
    ];

    res.writeHead(200, { 'Content-Type': 'video/mp4' });

    const ff = spawn(FFMPEG_PATH, args);
    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {}); // при отладке можно логировать
    ff.on('error', (e) => { console.error('ffmpeg error:', e); try { res.end(); } catch (_) {} });
    req.on('close', () => ff.kill('SIGKILL'));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('MyPlayer stream server listening on 127.0.0.1:' + PORT);
});
