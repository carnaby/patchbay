/*
 * Umami's `data-before-send` hook. The server only links this file when the operator turned Umami analytics on
 * (UMAMI_SCRIPT_URL and UMAMI_WEBSITE_ID); a self-hosted instance without them never loads it.
 *
 * A dashboard link works like a key: whoever has /d/<id> can open a public dashboard, and its title says what it
 * is. Neither may leave the browser, so every dashboard counts as "/d/:id" titled "Dashboard". Query strings and
 * fragments carry OAuth codes and state; the tracker is told to drop them, and this drops them again in case a
 * future tracker version reads its attributes differently.
 *
 * Plain ES5 in a static file, because the CSP allows no inline script.
 */
(function () {
  var DASHBOARD = /^\/d\/[^/]+/;

  function isDashboard(value) {
    try {
      var url = new URL(value, location.origin);
      return url.origin === location.origin && DASHBOARD.test(url.pathname);
    } catch (e) {
      return false;
    }
  }

  function clean(value) {
    if (typeof value !== 'string' || value === '') return value;
    try {
      var url = new URL(value, location.origin);
      url.search = '';
      url.hash = '';
      if (url.origin === location.origin) url.pathname = url.pathname.replace(DASHBOARD, '/d/:id');
      // Umami sends the page as an absolute URL and a same-origin referrer as a path; keep each in its form.
      return value.charAt(0) === '/' ? url.pathname : url.href;
    } catch (e) {
      return undefined;
    }
  }

  window.patchbayUmamiBeforeSend = function (type, payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (isDashboard(payload.url || location.href)) payload.title = 'Dashboard · Patchbay';
    if ('url' in payload) payload.url = clean(payload.url);
    if ('referrer' in payload) payload.referrer = clean(payload.referrer);
    return payload;
  };
})();
