'use strict';

/**
 * Standalone-сервис MyPlayer. Запускается как обычный Node-процесс на TV
 * (через SSH или автозапуском из /var/lib/webosbrew/init.d), НЕ как
 * официальный webOS Luna-сервис.
 *
 * HTTP-эндпоинты (127.0.0.1:PORT):
 *   GET /listDir?path=...            — список файлов/папок
 *   GET /probe?path=...              — всё о файле (потоки, кодеки, план: direct/remux/reencode, команда ffmpeg)
 *   GET /stream?path=...&start=N     — раздача файла (Range) или транскод/ремукс через ffmpeg
 *   GET /teststream?kind=...         — тестовые видео, которые генерирует сам ffmpeg
 *                                       kind: h264-frag | hevc10-frag | h264-file
 *   GET /debug                       — состояние сервиса и последнего запуска ffmpeg (для экрана отладки)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const PORT = process.env.MYPLAYER_PORT || 7788;
const STARTED_AT = Date.now();

const FFMPEG_PATH = process.env.MYPLAYER_FFMPEG || '/home/root/bin/ffmpeg';
const FFPROBE_PATH = process.env.MYPLAYER_FFPROBE || '/home/root/bin/ffprobe';

// Максимальная ширина видео при перекодировании (99999 = без ограничения).
const TRANSCODE_MAX_WIDTH = process.env.MYPLAYER_MAX_WIDTH ? parseInt(process.env.MYPLAYER_MAX_WIDTH, 10) : 99999;

// Телевизоры LG аппаратно декодируют 10-бит HEVC/HDR сами — по умолчанию
// такое видео просто копируем. true = принудительно перекодировать в 8-бит H.264.
const FORCE_REENCODE_HIGH_BIT_DEPTH = process.env.MYPLAYER_FORCE_REENCODE === 'true';

const ROOTS = (process.env.MYPLAYER_ROOTS || '/tmp/usb').split(':').filter(Boolean);

const DIRECT_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const NATIVE_VIDEO_CODECS = new Set(['h264', 'hevc']);
const NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3']);

const TEST_FILE = '/tmp/vlcwebos-test-h264.mp4';

// ---------- состояние для экрана отладки ----------
const debugState = {
  ffmpeg: null,   // последний запуск ffmpeg
  direct: null    // последняя раздача файла напрямую
};

// ---------- валидация путей ----------
function isValidPath(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return ROOTS.some(root => {
    try {
      const rootResolved = path.resolve(root);
      return resolved.startsWith(rootResolved);
    } catch (e) {
      return false;
    }
  });
}

function sanitizePath(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  if (!isValidPath(resolved)) {
    return null;
  }
  return resolved;
}

// ---------- утилиты ----------
function findUsbMountPoints() {
  const found = [];
  for (const usbRoot of ROOTS) {
    let disks;
    try { disks = fs.readdirSync(usbRoot, { withFileTypes: true }); } catch (e) { continue; }
    for (const disk of disks) {
      if (!disk.isDirectory()) continue;
      const diskPath = path.join(usbRoot, disk.name);
      let parts;
      try { parts = fs.readdirSync(diskPath, { withFileTypes: true }); } catch (e) { continue; }
      for (const part of parts) {
        if (!part.isDirectory()) continue;
        found.push({ name: 'USB: ' + part.name, isDir: true, path: path.join(diskPath, part.name) });
      }
    }
  }
  return found;
}

function mimeFor(ext) {
  switch (ext) {
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.srt': return 'text/plain; charset=utf-8';
    case '.vtt': return 'text/vtt; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function safeReaddir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, isDir: d.isDirectory(), path: path.join(dirPath, d.name) }))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  } catch (e) {
    return [];
  }
}

function ffmpegAvailable() { try { return fs.existsSync(FFMPEG_PATH); } catch (e) { return false; } }
function ffprobeAvailable() { try { return fs.existsSync(FFPROBE_PATH); } catch (e) { return false; } }

function niceAvailable() {
  try { execFileSync('sh', ['-c', 'command -v nice']); return true; } catch (e) { return false; }
}
const NICE_AVAILABLE = niceAvailable();

let FFMPEG_VERSION = 'n/a';
try {
  FFMPEG_VERSION = execFileSync(FFMPEG_PATH, ['-version']).toString().split('\n')[0];
} catch (e) { /* ffmpeg может быть ещё не установлен */ }

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---------- ffprobe ----------
function probeFile(filePath) {
  const raw = execFileSync(FFPROBE_PATH, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }).toString();

  const data = JSON.parse(raw);
  const allStreams = data.streams || [];
  const isCover = (s) => !!(s.disposition && s.disposition.attached_pic);

  const vStream = allStreams.find((s) => s.codec_type === 'video' && !isCover(s));
  const audioStreams = allStreams.filter((s) => s.codec_type === 'audio');
  const aStream = audioStreams.find((s) => s.disposition && s.disposition.default) || audioStreams[0];
  const duration = parseFloat((data.format && data.format.duration) || (vStream && vStream.duration) || (aStream && aStream.duration) || 0);

  const streamsSummary = allStreams.map((s) => ({
    i: s.index, t: s.codec_type, c: s.codec_name, profile: s.profile,
    pixFmt: s.pix_fmt, w: s.width, h: s.height, fps: s.r_frame_rate,
    ch: s.channels, layout: s.channel_layout,
    lang: s.tags && s.tags.language,
    def: !!(s.disposition && s.disposition.default),
    cover: isCover(s),
    br: s.bit_rate,
    transfer: s.color_transfer, primaries: s.color_primaries, space: s.color_space,
    side: (s.side_data_list || []).map((x) => x.side_data_type)
  }));

  const fmt = data.format || {};
  return {
    duration: isFinite(duration) ? duration : 0,
    hasVideo: !!vStream,
    hasAudio: !!aStream,
    vIndex: vStream ? vStream.index : undefined,
    aIndex: aStream ? aStream.index : undefined,
    vcodec: vStream ? vStream.codec_name : null,
    acodec: aStream ? aStream.codec_name : null,
    pixFmt: vStream ? vStream.pix_fmt : null,
    colorTransfer: vStream ? vStream.color_transfer : null,
    width: vStream ? vStream.width : null,
    container: { format: fmt.format_name, size: fmt.size, bitrate: fmt.bit_rate },
    streams: streamsSummary
  };
}

function isHighBitDepth(info) {
  return !!(info.pixFmt && /10le|12le|p10|p12/.test(info.pixFmt));
}
function isHdr(info) {
  return !!(info.colorTransfer && /smpte2084|arib-std-b67/.test(info.colorTransfer));
}

function isDirectPlayable(filePath, info) {
  const ext = path.extname(filePath).toLowerCase();
  if (!DIRECT_EXT.has(ext)) return false;
  if (info.hasVideo && !NATIVE_VIDEO_CODECS.has(info.vcodec)) return false;
  if (info.hasVideo && FORCE_REENCODE_HIGH_BIT_DEPTH && isHighBitDepth(info)) return false;
  if (info.hasAudio && !NATIVE_AUDIO_CODECS.has(info.acodec)) return false;
  return true;
}

// ---------- план ffmpeg ----------
function buildPlan(filePath, info, startSec, audioIndex, subIndex) {
  const needsReencode = !info || !info.hasVideo
    ? false
    : (!NATIVE_VIDEO_CODECS.has(info.vcodec) || (FORCE_REENCODE_HIGH_BIT_DEPTH && isHighBitDepth(info)));

  let kind;
  let vArgs;
  let inputArgs = [];  // доп. аргументы ПЕРЕД -i (например, явный декодер)

  if (!info) {
    kind = 'blind (ffprobe не сработал)';
    vArgs = ['-c:v', 'copy'];
  } else if (!info.hasVideo) {
    kind = 'audio-only';
    vArgs = ['-vn'];
  } else if (info.vcodec === 'av1') {
    // AV1: явно указываем libdav1d декодер + перекодируем в H.264
    // needsBuffer=true: ждём накопления буфера перед отдачей браузеру
    // (иначе браузер рвёт соединение пока AV1 декодируется)
    kind = 'reencode AV1->h264 (libdav1d)';
    inputArgs = ['-c:v', 'libdav1d'];
    vArgs = [
      '-threads', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-vf', "format=yuv420p,scale='min(" + TRANSCODE_MAX_WIDTH + ",iw)':-2"
    ];
  } else if (!needsReencode) {
    kind = 'remux (видео копируется)';
    vArgs = ['-c:v', 'copy'];
  } else if (isHdr(info)) {
    kind = 'reencode HDR->SDR';
    vArgs = [
      '-threads', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-vf', "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale='min(" + TRANSCODE_MAX_WIDTH + ",iw)':-2"
    ];
  } else {
    kind = 'reencode -> h264 8bit';
    vArgs = [
      '-threads', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-vf', "format=yuv420p,scale='min(" + TRANSCODE_MAX_WIDTH + ",iw)':-2"
    ];
  }

  const aArgs = (!info || info.hasAudio !== false)
    ? (info && NATIVE_AUDIO_CODECS.has(info.acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-bufsize', '192k'])
    : ['-an'];

  const args = [
    '-nostdin', '-hide_banner',
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    ...inputArgs,
    // -readrate 1.2: читаем файл не быстрее 1.2x реального времени.
    // Это предотвращает накопление данных в буфере Node/браузера и OOM.
    // Небольшой запас (1.2 а не 1.0) чтобы не было пауз при декодировании.
    '-readrate', '1.05',
    '-i', filePath,
    // Видео: всегда берём дефолтный видео-поток
    ...(info && info.hasVideo && info.vIndex !== undefined ? ['-map', '0:' + info.vIndex] : []),
    // Аудио: явно выбранная дорожка или дефолтная из probe
    ...(audioIndex !== null && audioIndex !== undefined
      ? ['-map', '0:' + audioIndex]
      : (info && info.hasAudio && info.aIndex !== undefined ? ['-map', '0:' + info.aIndex] : [])),
    '-sn',
    ...vArgs,
    ...aArgs,
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mpegts',
    'pipe:1'
  ];
  const needsBuffer = true; // всегда буферизуем
  return { kind, args, needsBuffer };
}

// ---------- запуск ffmpeg в HTTP-ответ ----------
function spawnFfmpeg(args) {
  return NICE_AVAILABLE
    ? spawn('nice', ['-n', '15', FFMPEG_PATH, ...args])
    : spawn(FFMPEG_PATH, args);
}

function runFfmpeg(req, res, args, meta) {
  res.setMaxListeners(20);
  const ff = spawnFfmpeg(args);
  const st = {
    kind: meta.kind, path: meta.path || null,
    cmd: 'ffmpeg ' + args.join(' '),
    pid: ff.pid, nice: NICE_AVAILABLE,
    startedAt: Date.now(), bytesSent: 0,
    running: true, exitCode: null, signal: null,
    closedByClient: false, error: null, stderrTail: '', currentSec: 0
  };
  debugState.ffmpeg = st;
  console.log('[ffmpeg] pid=' + ff.pid + ' kind=' + meta.kind);

  // Backpressure: пишем в ответ через drain чтобы не накапливать данные в RAM.
  // Если браузер не успевает читать — ffmpeg автоматически притормаживает.
  // Это предотвращает OOM при длительном воспроизведении 4K.
  let headersSent = false;
  let ffEnded = false;

  function sendHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  }

  function pump() {
    if (!ff.stdout.readable) return;
    let chunk;
    while ((chunk = ff.stdout.read()) !== null) {
      if (!headersSent) sendHeaders();
      st.bytesSent += chunk.length;
      if (!res.write(chunk)) {
        // Буфер записи переполнен — ждём drain прежде чем читать дальше
        ff.stdout.pause();
        res.once('drain', () => { ff.stdout.resume(); });
        return;
      }
    }
    if (ffEnded) {
      try { res.end(); } catch (_) {}
    }
  }

  ff.stdout.on('readable', pump);
  ff.stdout.on('end', () => {
    ffEnded = true;
    if (st.bytesSent > 0 || headersSent) {
      try { res.end(); } catch (_) {}
    }
  });

  ff.stderr.on('data', (c) => {
    const txt = c.toString();
    st.stderrTail = (st.stderrTail + txt).slice(-3000);
    const m = /time=([\d:]+\.?\d*)/.exec(txt);
    if (m) {
      const parts = m[1].split(':');
      st.currentSec = parts.reduce((acc, v) => acc * 60 + parseFloat(v), 0);
    }
  });

  ff.on('error', (e) => {
    st.running = false; st.error = e.message;
    console.error('[ffmpeg] ошибка запуска:', e);
    if (!headersSent) sendHeaders();
    try { res.end(); } catch (_) {}
  });

  ff.on('close', (code, signal) => {
    st.running = false; st.exitCode = code; st.signal = signal;
    console.log('[ffmpeg] завершился code=' + code + ' signal=' + signal + ' bytes=' + st.bytesSent + ' closedByClient=' + st.closedByClient);
    if (code !== 0 && code !== null) console.log('[ffmpeg] stderr:\n' + st.stderrTail);
  });

  req.on('close', () => {
    if (st.running && !res.writableFinished) {
      st.closedByClient = true;
      ff.kill('SIGKILL');
    }
  });
}

// ---------- раздача файла с Range ----------
function serveFileRange(req, res, filePath, contentType) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { res.writeHead(404); res.end('not found'); return; }
  const range = req.headers.range;
  debugState.direct = { path: filePath, contentType, size: stat.size, lastRange: range || null, at: Date.now() };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ---------- тестовые видео ----------
const TEST_SRC = [
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'
];
const FRAG_FLAGS = ['-f', 'mpegts'];

let testFileWaiters = null;
function ensureTestFile(cb) {
  try { if (fs.existsSync(TEST_FILE) && fs.statSync(TEST_FILE).size > 10000) { cb(null); return; } } catch (e) { /* ignore */ }
  if (testFileWaiters) { testFileWaiters.push(cb); return; }
  testFileWaiters = [cb];
  const g = spawnFfmpeg([
    '-nostdin', '-hide_banner', '-y', ...TEST_SRC, '-t', '20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', TEST_FILE
  ]);
  let err = '';
  g.stderr.on('data', (c) => { err = (err + c.toString()).slice(-2000); });
  g.on('error', (e) => { const w = testFileWaiters; testFileWaiters = null; w.forEach((f) => f(e.message)); });
  g.on('close', (code) => {
    const w = testFileWaiters; testFileWaiters = null;
    w.forEach((f) => f(code === 0 ? null : ('ffmpeg code ' + code + '\n' + err)));
  });
}

// ---------- сервер ----------
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const filePath = parsed.query.path;

  if (parsed.pathname === '/listDir') {
    if (!filePath) {
      const mounts = findUsbMountPoints();
      sendJson(res, 200, { entries: mounts.length === 1 ? safeReaddir(mounts[0].path) : mounts });
      return;
    }
    const sanitized = sanitizePath(filePath);
    if (!sanitized) {
      sendJson(res, 403, { error: 'Invalid path' });
      return;
    }
    sendJson(res, 200, { entries: safeReaddir(sanitized) });
    return;
  }

  if (parsed.pathname === '/kill') {
    const f = debugState.ffmpeg;
    if (f && f.running && f.pid) {
      try { process.kill(f.pid, 'SIGKILL'); } catch (e) { /* уже мёртв */ }
      f.running = false;
      console.log('[kill] убили ffmpeg pid=' + f.pid);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (parsed.pathname === '/position') {
    const f = debugState.ffmpeg;
    sendJson(res, 200, {
      running: !!(f && f.running),
      currentSec: (f && f.currentSec) || 0,
      bytesSent: (f && f.bytesSent) || 0
    });
    return;
  }

  if (parsed.pathname === '/debug') {
    sendJson(res, 200, {
      service: {
        node: process.version, arch: os.arch(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        loadavg: os.loadavg().map((x) => x.toFixed(2)), freeMemMB: Math.round(os.freemem() / 1048576),
        totalMemMB: Math.round(os.totalmem() / 1048576), cpus: os.cpus().length,
        ffmpeg: ffmpegAvailable(), ffprobe: ffprobeAvailable(), ffmpegVersion: FFMPEG_VERSION, nice: NICE_AVAILABLE,
        forceReencode10bit: FORCE_REENCODE_HIGH_BIT_DEPTH, maxWidth: TRANSCODE_MAX_WIDTH
      },
      ffmpeg: debugState.ffmpeg
        ? Object.assign({}, debugState.ffmpeg, { elapsedSec: Math.round((Date.now() - debugState.ffmpeg.startedAt) / 1000) })
        : null,
      direct: debugState.direct
    });
    return;
  }

  if (parsed.pathname === '/probe') {
    console.log('[probe] path=' + filePath);
    if (!filePath) { sendJson(res, 400, { error: 'Missing path' }); return; }
    const sanitized = sanitizePath(filePath);
    if (!sanitized) {
      sendJson(res, 403, { error: 'Invalid path' });
      return;
    }
    const extIsDirect = DIRECT_EXT.has(path.extname(sanitized).toLowerCase());

    if (!ffprobeAvailable()) {
      sendJson(res, 200, {
        duration: 0, hasVideo: true, hasAudio: true, direct: extIsDirect,
        warning: extIsDirect ? null : 'ffprobe не найден на TV — для этого формата нужен ffmpeg'
      });
      return;
    }
    try {
      const info = probeFile(sanitized);
      info.direct = fs.existsSync(sanitized) ? isDirectPlayable(sanitized, info) : false;
      if (info.direct) {
        info.plan = { kind: 'direct (файл отдаётся как есть, Range)', cmd: null };
      } else if (ffmpegAvailable()) {
        const plan = buildPlan(sanitized, info, 0);
        info.plan = { kind: plan.kind, cmd: 'ffmpeg ' + plan.args.join(' ') };
      } else {
        info.warning = 'Нужен транскод, но ffmpeg не найден на TV';
      }
      sendJson(res, 200, info);
    } catch (e) {
      sendJson(res, 200, {
        error: e.message, duration: 0, hasVideo: true, hasAudio: true, direct: extIsDirect,
        warning: extIsDirect ? null : 'ffprobe упал — не удалось определить кодеки'
      });
    }
    return;
  }

  if (parsed.pathname === '/subtitle') {
    if (!filePath) { sendJson(res, 400, { error: 'Missing path' }); return; }
    const sanitized = sanitizePath(filePath);
    if (!sanitized) {
      sendJson(res, 403, { error: 'Invalid path' });
      return;
    }
    const sidx = parsed.query.index;
    if (!sidx) { sendJson(res, 400, { error: 'Missing index' }); return; }
    if (!ffmpegAvailable()) { res.writeHead(500); res.end('ffmpeg not found'); return; }

    // ffmpeg не умеет писать WebVTT в pipe (non-seekable) — пишем во временный файл
    const tmpVtt = '/tmp/vlcwebos_sub_' + Date.now() + '.vtt';
    const args = ['-nostdin', '-hide_banner', '-y', '-i', sanitized, '-map', '0:' + sidx, '-c:s', 'webvtt', tmpVtt];
    console.log('[subtitle] конвертирую дорожку ' + sidx + ' -> ' + tmpVtt);
    const ff = spawn(FFMPEG_PATH, args);
    let ffErr = '';
    ff.stderr.on('data', (c) => { ffErr = (ffErr + c.toString()).slice(-2000); });
    ff.on('close', (code) => {
      if (code !== 0) {
        console.error('[subtitle] ffmpeg code=' + code + ' stderr:\n' + ffErr);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Ошибка конвертации: ' + ffErr.slice(-300));
        return;
      }
      try {
        const vtt = fs.readFileSync(tmpVtt, 'utf-8');
        try { fs.unlinkSync(tmpVtt); } catch (_) {}
        console.log('[subtitle] готово, ' + vtt.length + ' байт');
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(vtt);
      } catch (e) {
        console.error('[subtitle] ошибка чтения файла:', e);
        res.writeHead(500); res.end(e.message);
      }
    });
    ff.on('error', (e) => { console.error('[subtitle] spawn error:', e); res.writeHead(500); res.end(e.message); });
    req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
    return;
  }

  if (parsed.pathname === '/tracks') {
    if (!filePath) { sendJson(res, 400, { error: 'Missing path' }); return; }
    const sanitized = sanitizePath(filePath);
    if (!sanitized) {
      sendJson(res, 403, { error: 'Invalid path' });
      return;
    }
    console.log('[tracks] path=' + sanitized);
    if (!ffprobeAvailable()) { sendJson(res, 200, { audio: [], subs: [] }); return; }
    try {
      const info = probeFile(sanitized);
      const audio = (info.streams || [])
        .filter((s) => s.t === 'audio')
        .map((s) => ({ index: s.i, codec: s.c, channels: s.ch, layout: s.layout, lang: s.lang, label: [s.lang, s.c, s.layout].filter(Boolean).join(' ') }));
      const subs = (info.streams || [])
        .filter((s) => s.t === 'subtitle')
        .map((s) => ({ index: s.i, codec: s.c, lang: s.lang, label: [s.lang, s.c].filter(Boolean).join(' ') }));
      console.log('[tracks] audio=' + audio.length + ' subs=' + subs.length);
      sendJson(res, 200, { audio, subs });
    } catch (e) {
      console.error('[tracks] error:', e.message);
      sendJson(res, 200, { audio: [], subs: [], error: e.message });
    }
    return;
  }

  if (parsed.pathname === '/stream') {
    console.log('[stream] path=' + filePath + ' start=' + (parsed.query.start || '0') + ' range=' + (req.headers.range || '-'));
    if (!filePath) { res.writeHead(400); res.end('Missing path'); return; }
    const sanitized = sanitizePath(filePath);
    if (!sanitized) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid path');
      return;
    }

    const startSec = parseFloat(parsed.query.start || '0') || 0;
    const audioIndex = parsed.query.aid !== undefined ? parseInt(parsed.query.aid, 10) : null;
    const subIndex = parsed.query.sid !== undefined ? parseInt(parsed.query.sid, 10) : null;
    const localFile = fs.existsSync(sanitized);
    const ext = path.extname(sanitized).toLowerCase();
    const extIsDirect = DIRECT_EXT.has(ext);
    const hasStart = !!(parsed.query.start || parsed.query.aid !== undefined || parsed.query.sid !== undefined);

    let direct = false;
    let info = null;
    if (localFile && !hasStart) {
      if (!ffprobeAvailable()) {
        direct = extIsDirect;
      } else {
        try { info = probeFile(sanitized); direct = isDirectPlayable(sanitized, info); }
        catch (e) { direct = extIsDirect; }
      }
    }

    if (direct) { serveFileRange(req, res, sanitized, mimeFor(ext)); return; }

    if (!ffmpegAvailable()) {
      res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Этот формат требует ffmpeg на TV, а он не найден: ' + FFMPEG_PATH);
      return;
    }
    if (!info) { try { info = probeFile(sanitized); } catch (e) { info = null; } }

    const plan = buildPlan(sanitized, info, startSec, audioIndex, subIndex);
    if (!plan.args) {
      res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: plan.kind, vcodec: info ? info.vcodec : null }));
      return;
    }
    runFfmpeg(req, res, plan.args, { kind: plan.kind, path: sanitized, needsBuffer: plan.needsBuffer });
    return;
  }

  if (parsed.pathname === '/teststream') {
    const kind = parsed.query.kind;
    console.log('[teststream] kind=' + kind + ' range=' + (req.headers.range || '-'));
    if (!ffmpegAvailable()) {
      res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ffmpeg не найден: ' + FFMPEG_PATH);
      return;
    }
    if (kind === 'h264-frag') {
      runFfmpeg(req, res, [
        '-nostdin', '-hide_banner', ...TEST_SRC, '-t', '60',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
        '-c:a', 'aac', '-b:a', '128k', ...FRAG_FLAGS, 'pipe:1'
      ], { kind: 'TEST h264-ts (тест-картинка 720p, MPEG-TS поток)' });
      return;
    }
    if (kind === 'hevc10-frag') {
      // Тест C: берём реальный HEVC-файл с флешки и копируем видео напрямую в TS.
      // Это точно то же самое, что делает плеер при воспроизведении MKV.
      const testFile = '/tmp/usb/sda/sda2/VIDEO/Astérix & Obélix- Mission Cléopâtre (2002) UHD BDRip.4K.HDR.2160p.mkv';
      const fallback = '/tmp/usb/sda/sda2/VIDEO';
      // Берём первый попавшийся mkv если основной не найден
      let src = testFile;
      try {
        if (!fs.existsSync(testFile)) {
          const files = fs.readdirSync(fallback).filter((f) => f.endsWith('.mkv'));
          src = path.join(fallback, files[0]);
        }
      } catch (e) { /* используем основной */ }
      runFfmpeg(req, res, [
        '-nostdin', '-hide_banner',
        '-t', '30',
        '-i', src,
        '-map', '0:0', '-map', '0:1', '-sn',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
        '-avoid_negative_ts', 'make_zero',
        ...FRAG_FLAGS, 'pipe:1'
      ], { kind: 'TEST hevc-copy-ts (первые 30с реального HEVC MKV в TS)' });
      return;
    }
    if (kind === 'h264-file') {
      ensureTestFile((err) => {
        if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(String(err)); return; }
        serveFileRange(req, res, TEST_FILE, 'video/mp4');
      });
      return;
    }
    res.writeHead(400); res.end('unknown kind');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log('MyPlayer standalone service listening on 127.0.0.1:' + PORT);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' уже занят — старая копия сервиса ещё работает. Выполните: pkill -f "node service.js"');
  } else {
    console.error('Ошибка сервера:', e);
  }
  process.exit(1);
});
