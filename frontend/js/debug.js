/**
 * Экран отладки поверх плеера.
 *   Жёлтая (или Info)  — показать / скрыть
 *   Синяя              — следующая страница (1 плеер, 2 файл и сервис, 3 экран и события)
 *   Зелёная            — вкл/выкл прозрачный фон страницы (живой эксперимент: видео на webOS
 *                        рисуется на слое под страницей)
 *   Красная            — скрыть / показать панель управления
 * Для теста в обычном браузере: D, B, G, R.
 */
const Debug = (() => {
  const el = document.getElementById('debug');
  const video = Player.video;
  const PAGES = 3;
  const TITLES = ['ПЛЕЕР', 'ФАЙЛ И СЕРВИС', 'ЭКРАН И СОБЫТИЯ'];
  let visible = false;
  let page = 0;
  const events = [];
  let svc = null;
  let svcError = null;
  let svcFetchedAt = 0;

  function pad(n) { return String(n).padStart(2, '0'); }
  function ts() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function log(msg) { events.push(ts() + ' ' + msg); if (events.length > 40) events.shift(); }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function mb(b) { return (b / 1048576).toFixed(1) + ' МБ'; }
  function fx(n, d) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d == null ? 1 : d) : String(n); }

  ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
   'playing', 'pause', 'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'ended',
   'error', 'emptied', 'abort', 'resize', 'ratechange'].forEach((n) => {
    video.addEventListener(n, () => {
      let extra = '';
      if (n === 'error' && video.error) extra = ' code=' + video.error.code + ' ' + (video.error.message || '');
      if (n === 'resize' || n === 'loadedmetadata') extra = ' ' + video.videoWidth + 'x' + video.videoHeight;
      log(n + extra);
    });
  });

  function ranges(tr) {
    const out = [];
    for (let i = 0; i < tr.length; i++) out.push(fx(tr.start(i)) + '–' + fx(tr.end(i)));
    return out.join(', ') || 'нет';
  }

  const CODEC_TESTS = [
    ['hvc1 Main10', 'video/mp4; codecs="hvc1.2.4.L150.B0"'],
    ['hev1 Main10', 'video/mp4; codecs="hev1.2.4.L150.B0"'],
    ['hvc1 Main',   'video/mp4; codecs="hvc1.1.6.L150.B0"'],
    ['h264 High',   'video/mp4; codecs="avc1.640028"'],
    ['vp9',         'video/webm; codecs="vp9"'],
    ['av1',         'video/mp4; codecs="av01.0.08M.08"'],
    ['aac',         'audio/mp4; codecs="mp4a.40.2"'],
    ['ac3',         'audio/mp4; codecs="ac-3"'],
    ['eac3',        'audio/mp4; codecs="ec-3"']
  ];

  function pagePlayer() {
    const st = Player.getState();
    const L = [];
    L.push('режим: ' + st.mode + (st.mode === 'transcode' ? '   старт с: ' + fx(st.baseOffset) + ' с' : ''));
    L.push('src: ' + trunc(video.currentSrc || video.src || '(нет)', 130));
    L.push('картинка: ' + video.videoWidth + 'x' + video.videoHeight +
           '   readyState: ' + video.readyState + '   network: ' + video.networkState);
    L.push('время: ' + fx(video.currentTime) + ' / ' + fx(video.duration) +
           '   пауза: ' + video.paused + '   ended: ' + video.ended + '   seeking: ' + video.seeking);
    L.push('буфер: ' + ranges(video.buffered) + '   играет: ' + ranges(video.played));
    L.push('громкость: ' + video.volume + '   mute: ' + video.muted + '   скорость: ' + video.playbackRate);
    const dec = (k) => (video[k] !== undefined ? video[k] : 'n/a');
    L.push('кадров декод.: ' + dec('webkitDecodedFrameCount') + '   пропущено: ' + dec('webkitDroppedFrameCount'));
    L.push('байт декод. видео: ' + dec('webkitVideoDecodedByteCount') + '   аудио: ' + dec('webkitAudioDecodedByteCount'));
    try {
      L.push('дорожки: video=' + (video.videoTracks ? video.videoTracks.length : 'n/a') +
             ' audio=' + (video.audioTracks ? video.audioTracks.length : 'n/a') +
             ' text=' + (video.textTracks ? video.textTracks.length : 'n/a'));
    } catch (e) { /* ignore */ }
    const e = video.error;
    L.push('ОШИБКА: ' + (e ? ('код ' + e.code + ' ' + (e.message || '')) : 'нет'));
    L.push('--- canPlayType ---');
    L.push(CODEC_TESTS.map(([n, t]) => n + ': ' + (video.canPlayType(t) || 'нет')).join('   '));
    return L;
  }

  function streamLine(s) {
    const parts = ['#' + s.i, s.t, s.c];
    if (s.profile) parts.push(s.profile);
    if (s.t === 'video') {
      if (s.pixFmt) parts.push(s.pixFmt);
      parts.push(s.w + 'x' + s.h);
      if (s.fps) parts.push(s.fps + 'fps');
      if (s.transfer) parts.push('transfer=' + s.transfer);
      if (s.primaries) parts.push('prim=' + s.primaries);
      if (s.side && s.side.length) parts.push('side=' + s.side.join('+'));
    } else if (s.t === 'audio') {
      parts.push(s.ch + 'ch');
      if (s.layout) parts.push(s.layout);
    }
    if (s.lang) parts.push(s.lang);
    if (s.def) parts.push('[default]');
    if (s.cover) parts.push('[обложка]');
    return parts.join(' ');
  }

  function pageFile() {
    const st = Player.getState();
    const L = [];
    L.push('файл: ' + trunc(st.currentPath || '(нет)', 200));
    if (st.lastProbeError) L.push('probe ОШИБКА: ' + st.lastProbeError);
    const p = st.lastProbe;
    if (!p) {
      L.push('probe: ещё нет ответа');
    } else if (p.test) {
      L.push('тестовый поток: ' + p.test);
    } else {
      const c = p.container || {};
      L.push('контейнер: ' + c.format + '   размер: ' + (c.size ? mb(Number(c.size)) : '?') +
             '   битрейт: ' + (c.bitrate ? Math.round(Number(c.bitrate) / 1000) + ' кбит/с' : '?') +
             '   длит.: ' + fx(p.duration, 0) + ' с');
      (p.streams || []).forEach((s) => L.push(streamLine(s)));
      L.push('выбрано: видео #' + p.vIndex + ' (' + p.vcodec + ')   аудио #' + p.aIndex + ' (' + p.acodec + ')');
      L.push('direct: ' + p.direct + (p.plan ? '   план: ' + p.plan.kind : ''));
      if (p.plan && p.plan.cmd) L.push('cmd: ' + trunc(p.plan.cmd, 420));
      if (p.warning) L.push('ВНИМАНИЕ: ' + p.warning);
      if (p.error) L.push('ffprobe ошибка: ' + p.error);
    }
    L.push('--- сервис ---');
    if (svcError) {
      L.push('/debug ОШИБКА: ' + svcError);
    } else if (!svc) {
      L.push('загрузка…');
    } else {
      const s = svc.service || {};
      L.push('node ' + s.node + '  ' + s.arch + '  cpu×' + s.cpus + '  RAM свободно ' + s.freeMemMB + '/' + s.totalMemMB + ' МБ  load ' + (s.loadavg || []).join(' '));
      L.push('ffmpeg: ' + trunc(s.ffmpegVersion, 60) + '  nice: ' + s.nice + '  maxWidth: ' + s.maxWidth + '  reencode10bit: ' + s.forceReencode10bit);
      const f = svc.ffmpeg;
      if (!f) {
        L.push('ffmpeg ещё не запускался');
      } else {
        L.push('последний ffmpeg: ' + f.kind);
        L.push('pid ' + f.pid + '   ' + (f.running ? 'РАБОТАЕТ' : ('завершён code=' + f.exitCode + ' signal=' + f.signal)) +
               '   отдано: ' + mb(f.bytesSent) + '   прошло: ' + f.elapsedSec + ' с' +
               '   клиент оборвал: ' + f.closedByClient + (f.error ? '   ОШИБКА: ' + f.error : ''));
        L.push('cmd: ' + trunc(f.cmd, 420));
        const lines = String(f.stderrTail || '').split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean).slice(-5);
        L.push('stderr ffmpeg (хвост):');
        lines.forEach((x) => L.push('  ' + trunc(x, 150)));
      }
      if (svc.direct) {
        L.push('direct-раздача: ' + trunc(svc.direct.path, 90) + '  ' + mb(svc.direct.size) + '  Range: ' + svc.direct.lastRange);
      }
    }
    return L;
  }

  function cs(node, prop) {
    try { return node ? getComputedStyle(node)[prop] : 'нет элемента'; } catch (e) { return 'ошибка'; }
  }

  function pageScreen() {
    const L = [];
    L.push('окно: ' + window.innerWidth + 'x' + window.innerHeight + '  dpr=' + window.devicePixelRatio +
           '  screen: ' + screen.width + 'x' + screen.height);
    L.push('UA: ' + trunc(navigator.userAgent, 260));
    try {
      const info = (window.webOSSystem && window.webOSSystem.deviceInfo) || (window.PalmSystem && window.PalmSystem.deviceInfo);
      L.push('webOS deviceInfo: ' + trunc(info || 'n/a', 300));
    } catch (e) { L.push('webOS deviceInfo: ошибка'); }
    const hasPlaying = document.documentElement.classList.contains('playing');
    L.push('html.class = "' + document.documentElement.className + '"   прозрачный фон: ' + (hasPlaying ? 'ДА' : 'НЕТ'));
    L.push('фон: html=' + cs(document.documentElement, 'backgroundColor') +
           '  body=' + cs(document.body, 'backgroundColor') +
           '  #screen-player=' + cs(document.getElementById('screen-player'), 'backgroundColor') +
           '  #video=' + cs(video, 'backgroundColor'));
    const r = video.getBoundingClientRect();
    L.push('video rect: x=' + Math.round(r.left) + ' y=' + Math.round(r.top) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) +
           '  display=' + cs(video, 'display') + '  visibility=' + cs(video, 'visibility') + '  opacity=' + cs(video, 'opacity'));
    const ctl = document.getElementById('controls');
    L.push('панель управления: ' + (ctl && ctl.style.display === 'none' ? 'скрыта' : 'видна'));
    L.push('--- события видео (последние) ---');
    events.slice(-16).forEach((x) => L.push(x));
    return L;
  }

  function render() {
    const playerActive = document.getElementById('screen-player').classList.contains('active');
    el.classList.toggle('hidden', !visible || !playerActive);
    if (!visible || !playerActive) return;

    const now = Date.now();
    if (page === 1 && now - svcFetchedAt > 1500) {
      svcFetchedAt = now;
      fetch(getDebugUrl()).then((r) => r.json()).then((d) => { svc = d; svcError = null; })
        .catch((e) => { svcError = String(e && e.message ? e.message : e); });
    }

    const head = '[' + (page + 1) + '/' + PAGES + '] ' + TITLES[page] + '   ' + APP_BUILD + '\n' +
                 'жёлтая: скрыть · синяя: страница · зелёная: прозрачный фон · красная: панель';
    const body = [pagePlayer, pageFile, pageScreen][page]();
    el.textContent = head + '\n' + body.join('\n');
  }

  function toggle() { visible = !visible; render(); }
  function nextPage() { page = (page + 1) % PAGES; svcFetchedAt = 0; render(); }
  function toggleTransparent() {
    const on = document.documentElement.classList.toggle('playing');
    log('прозрачный фон: ' + (on ? 'ВКЛ' : 'ВЫКЛ'));
    render();
  }
  function toggleControls() {
    const ctl = document.getElementById('controls');
    ctl.style.display = ctl.style.display === 'none' ? '' : 'none';
    render();
  }

  document.addEventListener('app:debug-toggle', toggle);
  document.addEventListener('app:debug-page', nextPage);
  document.addEventListener('app:debug-transparent', toggleTransparent);
  document.addEventListener('app:debug-controls', toggleControls);

  // Клавиатура — только для теста в обычном браузере (в поле ввода не реагируем)
  document.addEventListener('keydown', (e) => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.keyCode === 68) toggle();
    else if (e.keyCode === 66) nextPage();
    else if (e.keyCode === 71) toggleTransparent();
    else if (e.keyCode === 82) toggleControls();
  });

  setInterval(render, 700);
  log('старт приложения ' + APP_BUILD);
  return { log, toggle, nextPage };
})();
