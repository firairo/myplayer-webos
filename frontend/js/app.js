const screens = {
  home: document.getElementById('screen-home'),
  browser: document.getElementById('screen-browser'),
  player: document.getElementById('screen-player')
};

// Тестовые видео, которые ffmpeg генерирует на TV (для диагностики вывода картинки)
const TESTS = {
  'test-h264-frag': { kind: 'h264-frag', label: 'Тест A: H.264 потоком (fMP4)' },
  'test-h264-file': { kind: 'h264-file', label: 'Тест B: H.264 обычный MP4-файл' },
  'test-hevc-frag': { kind: 'hevc10-frag', label: 'Тест C: HEVC 10-бит потоком (fMP4)' }
};

let pathStack = []; // стек пройденных папок для файлового браузера
let currentFilePath = null;   // путь к текущему файлу (для выбора дорожки)
let currentAudioIndex = null; // выбранная аудио-дорожка (индекс потока)
let currentSubIndex = null;   // выбранные субтитры (индекс потока), null = нет
let trackDialogMode = null;   // 'audio' | 'sub'
let urlFormOpen = false;

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
  document.documentElement.classList.toggle('playing', name === 'player');
  if (name === 'player') { showControls(); }
  Remote.refresh(screens[name]);
}

// ---------- Главное меню ----------
document.getElementById('main-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'open-url') {
    urlFormOpen = true;
    document.getElementById('url-form').classList.remove('hidden');
    Remote.refresh(document.getElementById('screen-home'));
    document.getElementById('url-input').focus();
  } else if (btn.dataset.action === 'open-browser') {
    pathStack = [];
    openBrowser(null);
  } else if (TESTS[btn.dataset.action]) {
    const t = TESTS[btn.dataset.action];
    showScreen('player');
    Player.playTest(t.kind, t.label);
  }
});

document.getElementById('url-form').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'play-url') {
    const url = document.getElementById('url-input').value.trim();
    if (url) {
      showScreen('player');
      Player.playSmart(url, url, null);
    }
  } else if (btn.dataset.action === 'cancel-url') {
    urlFormOpen = false;
    document.getElementById('url-form').classList.add('hidden');
    Remote.refresh(document.getElementById('screen-home'));
  }
});

// ---------- Файловый браузер ----------
function openBrowser(dirPath) {
  showScreen('browser');
  document.getElementById('breadcrumb').textContent = dirPath || 'USB-накопитель';
  const list = document.getElementById('file-list');
  list.innerHTML = '<div class="file-item">Загрузка...</div>';

  listDir(dirPath, (data) => {
    renderEntries(data.entries || []);
  }, (err) => {
    list.innerHTML = '<div class="file-item">Ошибка: ' + (err.errorText || 'сервис недоступен') + '</div>';
  });
}

function renderEntries(entries) {
  const list = document.getElementById('file-list');
  list.innerHTML = '';

  if (!entries.length) {
    list.innerHTML = '<div class="file-item">Пусто</div>';
    Remote.refresh(screens.browser);
    return;
  }

  entries.forEach((entry) => {
    const el = document.createElement('div');
    el.dataset.focusable = 'true';
    el.tabIndex = -1;
    el.textContent = entry.name;

    const isSub = !entry.isDir && /\.(srt|vtt)$/i.test(entry.name);
    const isAudio = !entry.isDir && /\.(mp3|flac|wav|ogg|oga|opus|m4a|wma|aac|ape|alac|aiff?)$/i.test(entry.name);
    el.classList.add('file-item', entry.isDir ? 'is-dir' : (isSub ? 'is-sub' : (isAudio ? 'is-audio' : 'is-video')));

    el.addEventListener('click', () => {
      if (entry.isDir) {
        pathStack.push(entry.path);
        openBrowser(entry.path);
      } else if (!isSub) {
        const subtitlePath = findMatchingSubtitle(entries, entry);
        currentFilePath = entry.path;
        currentAudioIndex = null;
        currentSubIndex = null;
        showScreen('player');
        fetch(getKillUrl()).catch(() => {});
        Player.playSmart(entry.path, entry.name, subtitlePath);
      }
    });

    list.appendChild(el);
  });

  Remote.refresh(screens.browser);
}

function findMatchingSubtitle(entries, videoEntry) {
  const base = videoEntry.name.replace(/\.[^.]+$/, '');
  const match = entries.find((e) => !e.isDir && e.name.startsWith(base) && /\.(srt|vtt)$/i.test(e.name));
  return match ? match.path : null;
}

// ---------- Плеер: кнопки управления ----------
// Автоскрытие оверлея через 10 секунд бездействия
const controls = document.getElementById('controls');
let hideTimer = null;

function showControls() {
  controls.style.display = '';
  Remote.refresh(document.getElementById('screen-player'));
  clearTimeout(hideTimer);
  // Скрываем только если плеер активен и видео играет
  hideTimer = setTimeout(() => {
    if (document.getElementById('screen-player').classList.contains('active') && !Player.video.paused) {
      controls.style.display = 'none';
    }
  }, 10000);
}

function resetHideTimer() {
  if (document.getElementById('screen-player').classList.contains('active')) {
    showControls();
  }
}

// Показываем оверлей при любой активности
document.addEventListener('keydown', resetHideTimer);
Player.video.addEventListener('pause', showControls);
Player.video.addEventListener('play', resetHideTimer);

document.getElementById('controls').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  switch (btn.dataset.action) {
    case 'toggle-play': Player.togglePlay(); break;
    case 'audio-track': openTrackDialog('audio'); break;
    case 'seek-back': Player.seekBy(-10); break;
    case 'seek-fwd': Player.seekBy(10); break;
    case 'close-player': closePlayer(); break;
  }
});

// ---------- Диалог выбора дорожки ----------
function openTrackDialog(mode) {
  if (!currentFilePath) return;
  trackDialogMode = mode;
  const dialog = document.getElementById('track-dialog');
  const title = document.getElementById('track-dialog-title');
  const list = document.getElementById('track-list');
  title.textContent = mode === 'audio' ? '🎵 Выбор аудио-дорожки' : '💬 Выбор субтитров';
  list.innerHTML = '<div class="track-item">Загрузка…</div>';
  dialog.classList.remove('hidden');
  Remote.refresh(dialog);

  fetch(getTracksUrl(currentFilePath))
    .then((r) => r.json())
    .then((data) => {
      list.innerHTML = '';
      const tracks = mode === 'audio' ? data.audio : data.subs;

      if (mode === 'sub') {
        // Добавляем пункт "Нет субтитров"
        const none = document.createElement('div');
        none.className = 'track-item' + (currentSubIndex === null ? ' active-track' : '');
        none.dataset.focusable = 'true';
        none.tabIndex = -1;
        none.textContent = '— Без субтитров —';
        none.addEventListener('click', () => {
          currentSubIndex = null;
          replayWithTracks();
          closeTrackDialog();
        });
        list.appendChild(none);
      }

      if (!tracks || tracks.length === 0) {
        list.innerHTML += '<div class="track-item">Нет доступных дорожек</div>';
        Remote.refresh(dialog);
        return;
      }

      tracks.forEach((t) => {
        const el = document.createElement('div');
        el.className = 'track-item';
        const activeIdx = mode === 'audio' ? currentAudioIndex : currentSubIndex;
        if (activeIdx === t.index) el.classList.add('active-track');
        el.dataset.focusable = 'true';
        el.tabIndex = -1;
        el.textContent = '#' + t.index + '  ' + t.label;
        el.addEventListener('click', () => {
          if (mode === 'audio') currentAudioIndex = t.index;
          else currentSubIndex = t.index;
          replayWithTracks();
          closeTrackDialog();
        });
        list.appendChild(el);
      });
      Remote.refresh(dialog);
    })
    .catch((e) => {
      list.innerHTML = '<div class="track-item">Ошибка: ' + e.message + '</div>';
      Remote.refresh(dialog);
    });
}

function closeTrackDialog() {
  document.getElementById('track-dialog').classList.add('hidden');
  Remote.refresh(document.getElementById('screen-player'));
}

/** Перезапускаем текущий файл с выбранными дорожками. */
function replayWithTracks() {
  if (!currentFilePath) return;

  // Снимаем все значения сразу чтобы не потерять при async операциях
  const savedTime = Player.displayedTime();
  const savedPath = currentFilePath;
  const savedAudio = currentAudioIndex;
  const label = Player.currentLabel || savedPath;

  fetch(getKillUrl()).catch(() => {});

  setTimeout(() => {
    const streamUrl = getStreamUrl(savedPath) +
      (savedAudio !== null ? '&aid=' + savedAudio : '') +
      (savedTime > 2 ? '&start=' + encodeURIComponent(savedTime.toFixed(3)) : '');

    // Для всех MKV используем transcode-режим (знаем что не direct)
    // Probe делаем только чтобы узнать длительность
    fetch(getProbeUrl(savedPath))
      .then((r) => r.json())
      .then((info) => {
        if (info.direct) {
          Player.playDirect(streamUrl, label, null, 'direct');
        } else {
          // Напрямую ставим src без промежуточных вызовов
          Player.video.src = streamUrl;
          Player.video.play().catch(() => {});
          // Обновляем внутреннее состояние плеера
          Player.setTranscodeState(savedPath, label, info.duration || 0, savedTime);
        }
      })
      .catch(() => {
        Player.video.src = streamUrl;
        Player.video.play().catch(() => {});
        Player.setTranscodeState(savedPath, label, 0, savedTime);
      });
  }, 500);
}

function loadAndAttachSubtitles(filePath, subIndex) {
  const subUrl = 'http://127.0.0.1:7788/subtitle?path=' + encodeURIComponent(filePath) + '&index=' + subIndex;
  fetch(subUrl)
    .then((r) => r.text())
    .then((vtt) => {
      if (!vtt || !vtt.includes('WEBVTT')) {
        console.warn('Субтитры: некорректный WebVTT ответ');
        return;
      }
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);
      function attach() {
        Array.from(Player.video.querySelectorAll('track')).forEach((t) => t.remove());
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = 'Sub';
        track.src = blobUrl;
        track.default = true;
        Player.video.appendChild(track);
        setTimeout(() => {
          if (Player.video.textTracks[0]) Player.video.textTracks[0].mode = 'showing';
        }, 500);
      }
      if (Player.video.readyState >= 1) {
        attach();
      } else {
        Player.video.addEventListener('loadedmetadata', attach, { once: true });
      }
    })
    .catch((e) => console.warn('Субтитры не загрузились:', e));
}

function closePlayer() {
  fetch(getKillUrl()).catch(() => {});
  Player.stop();
  if (pathStack.length) {
    showScreen('browser');
  } else {
    showScreen('home');
  }
}

// ---------- Глобальные события пульта ----------
document.addEventListener('app:back', () => {
  if (!document.getElementById('track-dialog').classList.contains('hidden')) {
    closeTrackDialog();
    return;
  }
  if (screens.player.classList.contains('active')) {
    closePlayer();
  } else if (screens.browser.classList.contains('active')) {
    pathStack.pop();
    if (pathStack.length) {
      openBrowser(pathStack[pathStack.length - 1]);
    } else {
      showScreen('home');
    }
  } else if (urlFormOpen) {
    urlFormOpen = false;
    document.getElementById('url-form').classList.add('hidden');
    Remote.refresh(document.getElementById('screen-home'));
  }
});

document.addEventListener('app:playpause', () => {
  if (screens.player.classList.contains('active')) Player.togglePlay();
});

document.addEventListener('app:seek', (e) => {
  if (screens.player.classList.contains('active')) Player.seekBy(e.detail);
});

// ---------- Старт ----------
showScreen('home');
