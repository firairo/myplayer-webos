/**
 * Клиент для локального Node-сервиса (tv-service/service.js), который
 * крутится на самом TV как обычный процесс на 127.0.0.1:7788.
 */
const SERVICE_BASE = 'http://127.0.0.1:7788';
const APP_BUILD = 'build 8 · 2026-09-28';

function listDir(path, onSuccess, onFailure) {
  const q = path ? '?path=' + encodeURIComponent(path) : '';
  fetch(SERVICE_BASE + '/listDir' + q)
    .then((r) => r.json())
    .then((data) => onSuccess && onSuccess(data))
    .catch((e) => onFailure && onFailure({ errorText: e.message }));
}

function getStreamUrl(filePath) {
  return SERVICE_BASE + '/stream?path=' + encodeURIComponent(filePath);
}

function getProbeUrl(filePath) {
  return SERVICE_BASE + '/probe?path=' + encodeURIComponent(filePath);
}

function getDebugUrl() {
  return SERVICE_BASE + '/debug';
}

function getTestUrl(kind) {
  // t=... чтобы браузер не брал ответ из кэша
  return SERVICE_BASE + '/teststream?kind=' + encodeURIComponent(kind) + '&t=' + Date.now();
}

function getTracksUrl(filePath) {
  return SERVICE_BASE + '/tracks?path=' + encodeURIComponent(filePath);
}

function getSubtitleUrl(filePath, streamIndex) {
  return SERVICE_BASE + '/subtitle?path=' + encodeURIComponent(filePath) + '&index=' + streamIndex;
}

function getKillUrl() { return SERVICE_BASE + '/kill'; }
