/**
 * Простая навигация фокусом по элементам с [data-focusable] в пределах
 * активного экрана (.screen.active). Работает по вертикальному списку
 * (Up/Down), Enter/OK выбирает, Back — событие 'app:back'.
 *
 * Коды клавиш пульта webOS TV (стандартные + доп. кнопки):
 *  37/38/39/40 - стрелки, 13 - OK/Enter, 461 - Back,
 *  415 - Play, 19 - Pause, 179 - PlayPause, 412 - Rewind, 417 - FastForward
 */
const Remote = (() => {
  let focusables = [];
  let currentIndex = 0;

  function refresh(scope) {
    const root = scope || document.querySelector('.screen.active');
    focusables = Array.from(root.querySelectorAll('[data-focusable]'))
      .filter((el) => el.offsetParent !== null);
    currentIndex = Math.max(0, focusables.findIndex((el) => el.classList.contains('focused')));
    if (currentIndex === -1) currentIndex = 0;
    applyFocus();
  }

  function applyFocus() {
    focusables.forEach((el, i) => el.classList.toggle('focused', i === currentIndex));
    const el = focusables[currentIndex];
    if (el) el.focus && el.focus();
  }

  function move(delta) {
    if (!focusables.length) return;
    currentIndex = (currentIndex + delta + focusables.length) % focusables.length;
    applyFocus();
  }

  function activateCurrent() {
    const el = focusables[currentIndex];
    if (!el) return;
    if (el.tagName === 'INPUT') return; // текстовый ввод обрабатывается отдельно
    el.click();
  }

  document.addEventListener('keydown', (e) => {
    const activeIsInput = document.activeElement && document.activeElement.tagName === 'INPUT';

    switch (e.keyCode) {
      case 38: // Up
        if (!activeIsInput) { move(-1); e.preventDefault(); }
        break;
      case 40: // Down
        if (!activeIsInput) { move(1); e.preventDefault(); }
        break;
      case 37: // Left
        document.dispatchEvent(new CustomEvent('app:left'));
        break;
      case 39: // Right
        document.dispatchEvent(new CustomEvent('app:right'));
        break;
      case 13: // Enter/OK — в плеере пауза, в меню выбор
        if (!activeIsInput) {
          if (document.getElementById('screen-player').classList.contains('active')) {
            document.dispatchEvent(new CustomEvent('app:playpause'));
          } else {
            activateCurrent();
          }
          e.preventDefault();
        }
        break;
      case 461: // Back (webOS)
      case 27:  // Esc (для теста в обычном браузере)
        document.dispatchEvent(new CustomEvent('app:back'));
        e.preventDefault();
        break;
      // --- Отладка (цветные кнопки пульта; буквы — для теста с клавиатуры) ---
      case 405: case 457:           // жёлтая / Info — показать/скрыть отладку
        document.dispatchEvent(new CustomEvent('app:debug-toggle'));
        e.preventDefault();
        break;
      case 406:                     // синяя — следующая страница отладки
        document.dispatchEvent(new CustomEvent('app:debug-page'));
        e.preventDefault();
        break;
      case 404:                     // зелёная — вкл/выкл прозрачный фон (эксперимент)
        document.dispatchEvent(new CustomEvent('app:debug-transparent'));
        e.preventDefault();
        break;
      case 403:                     // красная — скрыть/показать панель управления
        document.dispatchEvent(new CustomEvent('app:debug-controls'));
        e.preventDefault();
        break;
      case 415: case 19: case 179: // Play / Pause / PlayPause
        document.dispatchEvent(new CustomEvent('app:playpause'));
        break;
      case 412: // Rewind
        document.dispatchEvent(new CustomEvent('app:seek', { detail: -10 }));
        break;
      case 417: // FastForward
        document.dispatchEvent(new CustomEvent('app:seek', { detail: 10 }));
        break;
    }
  });

  return { refresh };
})();
