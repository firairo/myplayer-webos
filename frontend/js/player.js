const Player = (() => {
  const video = document.getElementById('video');
  const seek = document.getElementById('seek');
  const timeCurrent = document.getElementById('time-current');
  const timeDuration = document.getElementById('time-duration');
  const nowPlaying = document.getElementById('now-playing');

  let seeking = false;
  let mode = 'idle';          // 'direct' | 'transcode' | 'test:...'
  let baseOffset = 0;         // сек., с которых начат текущий transcode-поток
  let knownDuration = 0;      // длительность файла из /probe (у fMP4-потока её нет)
  let currentPath = null;
  let currentSubtitlePath = null;
  let currentLabel = '';
  let lastProbe = null;
  let lastProbeError = null;

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  }

  function setLabel(text) {
    currentLabel = text || '';
    nowPlaying.textContent = currentLabel;
  }

  let currentBlobUrl = null;

  function revokeBlobUrl() {
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  }

  function attachSubsIfNeeded() {
    if (currentSubtitlePath) attachSubtitles(video, currentSubtitlePath);
  }

  /** Прямое воспроизведение по URL (обычная раздача или тестовый поток). */
  function playDirect(src, label, subtitlePath, modeName) {
    mode = modeName || 'direct';
    baseOffset = 0;
    knownDuration = 0;
    currentSubtitlePath = subtitlePath || null;
    setLabel(label);
    video.src = src;
    video.play().catch((e) => console.warn('play() отклонён:', e));
    video.addEventListener('loadedmetadata', attachSubsIfNeeded, { once: true });
  }

  /** Воспроизведение через сервис-стример с ремуксом/перекодированием. */
  function playTranscoded(filePath, label, subtitlePath, duration, startAt) {
    mode = 'transcode';
    baseOffset = startAt || 0;
    lastKnownTime = startAt || 0;
    knownDuration = duration || 0;
    currentSubtitlePath = subtitlePath || null;
    currentPath = filePath;
    setLabel(label);
    video.src = getStreamUrl(filePath) + '&start=' + encodeURIComponent(baseOffset);
    video.play().catch((e) => console.warn('play() отклонён:', e));
    video.addEventListener('loadedmetadata', attachSubsIfNeeded, { once: true });
  }

  /** Тестовый поток, который генерирует сам ffmpeg на TV. */
  function playTest(kind, label) {
    lastProbe = { test: kind };
    lastProbeError = null;
    currentPath = 'ТЕСТ: ' + kind;
    playDirect(getTestUrl(kind), label, null, 'test:' + kind);
  }

  /** Спрашиваем /probe и решаем: direct или ремукс/транскод. */
  function playSmart(filePathOrUrl, label, subtitlePath) {
    lastProbe = null;
    lastProbeError = null;
    currentPath = filePathOrUrl;
    const isHttp = /^https?:\/\//i.test(filePathOrUrl);
    fetch(getProbeUrl(filePathOrUrl))
      .then((r) => r.json())
      .then((info) => {
        lastProbe = info;
        if (info.error && !info.direct) {
          // Сервис вернул ошибку (например AV1 без декодера)
          nowPlaying.textContent = '⚠️ ' + info.error + (info.vcodec ? ' [' + info.vcodec + ']' : '');
          return;
        }
        if (info.direct) {
          playDirect(getStreamUrl(filePathOrUrl), label, subtitlePath, 'direct');
        } else {
          playTranscoded(filePathOrUrl, label, subtitlePath, info.duration, 0);
        }
      })
      .catch((e) => {
        lastProbeError = String(e && e.message ? e.message : e);
        playDirect(isHttp ? filePathOrUrl : getStreamUrl(filePathOrUrl), label, subtitlePath, 'direct');
      });
  }

  function stop() {
    stopPositionPoller();
    video.pause();
    video.removeAttribute('src');
    video.load();
    mode = 'idle';
    baseOffset = 0;
    knownDuration = 0;
    lastKnownTime = 0;
  }

  function togglePlay() {
    if (video.paused) video.play(); else video.pause();
  }

  let lastKnownTime = 0;  // последняя известная позиция для transcode

  video.addEventListener('timeupdate', () => {
    if (mode === 'transcode' && video.currentTime > 0) {
      lastKnownTime = baseOffset + video.currentTime;
    }
  });

  function displayedTime() {
    if (mode === 'transcode') {
      // Если video ещё не начал играть (currentTime=0), используем позицию из /position
      return lastKnownTime || baseOffset;
    }
    return video.currentTime || 0;
  }

  function displayedDuration() {
    return mode === 'transcode' ? knownDuration : video.duration;
  }

  function seekBy(deltaSec) {
    seekTo(Math.max(0, displayedTime() + deltaSec));
  }

  function seekTo(targetSec) {
    if (mode !== 'transcode') {
      video.currentTime = Math.max(0, Math.min(video.duration || 0, targetSec));
      return;
    }
    // transcode: перезапускаем поток с новой стартовой позиции
    const clamped = Math.max(0, Math.min(knownDuration || targetSec, targetSec));
    playTranscoded(currentPath, currentLabel, currentSubtitlePath, knownDuration, clamped);
  }

  function toggleSubtitles() {
    const track = video.textTracks[0];
    if (!track) return;
    track.mode = track.mode === 'showing' ? 'hidden' : 'showing';
  }

  // Polling позиции для transcode-режима (раз в секунду)
  let positionPoller = null;
  function startPositionPoller() {
    stopPositionPoller(); // всегда останавливаем старый
    positionPoller = setInterval(() => {
      if (mode !== 'transcode') { stopPositionPoller(); return; }
      fetch(getPositionUrl()).then((r) => r.json()).then((d) => {
        if (d.running && d.currentSec > 0) {
          lastKnownTime = d.currentSec;
          const dur = knownDuration;
          timeCurrent.textContent = fmt(d.currentSec);
          timeDuration.textContent = fmt(dur);
          if (dur) seek.value = String((d.currentSec / dur) * 1000);
        }
      }).catch(() => {});
    }, 1000);
  }
  function stopPositionPoller() {
    if (positionPoller) { clearInterval(positionPoller); positionPoller = null; }
  }

  video.addEventListener('error', () => {
    const err = video.error;
    let msg = 'Не удалось воспроизвести файл.';
    if (err && err.code === 4) msg = 'Формат не поддерживается (см. отладку — жёлтая кнопка).';
    nowPlaying.textContent = '⚠️ ' + msg;
  });

  video.addEventListener('timeupdate', () => {
    if (seeking) return;
    const cur = displayedTime();
    const dur = displayedDuration();
    timeCurrent.textContent = fmt(cur);
    timeDuration.textContent = fmt(dur);
    if (dur) seek.value = String((cur / dur) * 1000);
  });

  seek.addEventListener('input', () => {
    seeking = true;
    const dur = displayedDuration();
    if (dur) timeCurrent.textContent = fmt((Number(seek.value) / 1000) * dur);
  });
  seek.addEventListener('change', () => {
    const dur = displayedDuration();
    if (dur) seekTo((Number(seek.value) / 1000) * dur);
    seeking = false;
  });

  /** Всё, что нужно экрану отладки. */
  function getState() {
    return {
      mode, baseOffset, knownDuration, currentPath, currentLabel,
      lastProbe, lastProbeError
    };
  }

  /** Запускает URL с заданным смещением (для перезапуска после смены дорожки). */
  function playDirectWithOffset(src, label, offsetSec) {
    mode = 'direct';
    baseOffset = 0;
    knownDuration = 0;
    setLabel(label);
    video.src = src;
    video.addEventListener('loadedmetadata', () => {
      if (offsetSec > 0) video.currentTime = offsetSec;
    }, { once: true });
    video.play().catch((e) => console.warn('play() отклонён:', e));
  }

  /** Обновляет внутреннее состояние транскода без перезапуска видео (для smena дорожки). */
  function setTranscodeState(filePath, label, duration, startAt) {
    mode = 'transcode';
    currentPath = filePath;
    baseOffset = startAt || 0;
    lastKnownTime = startAt || 0;
    knownDuration = duration || 0;
    setLabel(label);
    startPositionPoller();
  }

  return { playSmart, playDirect, playTranscoded, playTest, playDirectWithOffset, setTranscodeState, stop,
           togglePlay, seekBy, seekTo, displayedTime, toggleSubtitles, getState, video,
           get currentLabel() { return currentLabel; } };
})();
