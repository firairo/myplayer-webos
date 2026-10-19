function srtTimeToVtt(t) {
  return t.trim().replace(',', '.');
}

function srtToVtt(srtText) {
  const body = srtText
    .replace(/\r+/g, '')
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n').filter(Boolean);
      // первая строка — порядковый номер, вторая — таймкоды
      const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeLineIdx === -1) return '';
      const timeLine = lines[timeLineIdx]
        .split(' --> ')
        .map(srtTimeToVtt)
        .join(' --> ');
      const text = lines.slice(timeLineIdx + 1).join('\n');
      return timeLine + '\n' + text;
    })
    .filter(Boolean)
    .join('\n\n');

  return 'WEBVTT\n\n' + body;
}

/**
 * Загружает субтитры (.srt или .vtt) через сервис-стример и подключает их
 * к видео как blob-URL WebVTT track.
 */
function attachSubtitles(videoEl, filePath) {
  const isSrt = filePath.toLowerCase().endsWith('.srt');
  fetch(getStreamUrl(filePath))
    .then((r) => r.text())
    .then((text) => {
      const vtt = isSrt ? srtToVtt(text) : text;
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);

      Array.from(videoEl.querySelectorAll('track')).forEach((t) => t.remove());

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = 'Субтитры';
      track.srclang = 'ru';
      track.src = url;
      track.default = true;
      videoEl.appendChild(track);
      videoEl.textTracks[0] && (videoEl.textTracks[0].mode = 'showing');
    })
    .catch((e) => console.warn('Не удалось загрузить субтитры:', e));
}
