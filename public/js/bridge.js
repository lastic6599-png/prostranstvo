// Мост между веб-приложением и нативной iOS-оболочкой.
// В браузере всё работает через веб-API; внутри WKWebView сообщения уходят в Swift
// через window.webkit.messageHandlers.native (см. ios/README в корневом README).
(function () {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;

  function post(type, payload) {
    if (!handler) return false;
    handler.postMessage({ type, payload: payload || {} });
    return true;
  }

  window.NativeBridge = {
    isNative: !!handler,

    // Тактильный отклик: 'light' | 'medium' | 'success' | 'warning'
    haptic(style) {
      if (post('haptic', { style })) return;
      if (navigator.vibrate) navigator.vibrate(style === 'success' ? [10, 40, 10] : 10);
    },

    share(data) {
      if (post('share', data)) return;
      if (navigator.share) navigator.share(data).catch(() => {});
    },

    // Сообщает оболочке о событии (для локальных уведомлений, аналитики, бейджа на иконке)
    event(name, payload) {
      post('event', Object.assign({ name }, payload));
    },

    setBadge(count) {
      post('badge', { count });
    },
  };
})();
