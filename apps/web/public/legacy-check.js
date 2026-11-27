// Shows a readable message on browsers too old to run the app, instead of a black screen. A classic ES5 script (no
// module, no inline code: the CSP allows only same-origin scripts) so even an old TV engine can parse and run it.
(function () {
  'use strict';

  var MESSAGE_ID = 'pb-legacy';
  // Long enough for a slow TV to download and mount the bundle; a modern browser has rendered long before.
  var WAIT_AFTER_LOAD_MS = 15000;

  function supported() {
    try {
      var css = window.CSS;
      return !!(
        // Module scripts: without them the bundle never starts.
        'noModule' in window.HTMLScriptElement.prototype &&
        // Tailwind v4 colours use color-mix (Chrome 111, Safari 16.2).
        css.supports('color', 'color-mix(in srgb, red, blue)') &&
        // Tailwind v4 registers custom properties with @property (Safari 16.4, Firefox 128).
        typeof css.registerProperty === 'function' &&
        // Cascade layers, which Tailwind v4 wraps all its styles in.
        'CSSLayerBlockRule' in window &&
        // Built-ins the app's own code calls without a polyfill.
        typeof window.Object.hasOwn === 'function' &&
        typeof window.Array.prototype.at === 'function' &&
        typeof window.Array.prototype.findLast === 'function' &&
        typeof window.String.prototype.replaceAll === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  function show() {
    if (document.getElementById(MESSAGE_ID)) return;
    var dark = false;
    try {
      dark = document.documentElement.dataset.theme === 'dark';
    } catch (e) {}
    var box = document.createElement('div');
    box.id = MESSAGE_ID;
    var s = box.style;
    s.position = 'fixed';
    s.top = '0';
    s.left = '0';
    s.right = '0';
    s.bottom = '0';
    s.zIndex = '2147483647';
    s.boxSizing = 'border-box';
    s.padding = '8vh 8vw';
    s.overflow = 'auto';
    s.background = dark ? '#0d0d0d' : '#f9f9f7';
    s.color = dark ? '#ededed' : '#1a1a1a';
    s.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    s.fontSize = '22px';
    s.lineHeight = '1.5';
    var lines = [
      'Patchbay cannot run in this browser.',
      'It needs Chrome or Edge 111 or newer, Safari 16.4 or newer, or Firefox 128 or newer.',
      'On a TV, open this page in a newer browser, or use a streaming stick or box with a current browser.',
      'If your browser is up to date, reload the page.',
    ];
    for (var i = 0; i < lines.length; i++) {
      var p = document.createElement('p');
      p.textContent = lines[i];
      p.style.margin = '0 0 1em';
      if (i === 0) {
        p.style.fontSize = '28px';
        p.style.fontWeight = '600';
      }
      box.appendChild(p);
    }
    document.body.appendChild(box);
    return box;
  }

  function hideRoot() {
    var root = document.getElementById('root');
    if (root) root.style.display = 'none';
  }

  function hasApp() {
    var root = document.getElementById('root');
    return !!root && root.childNodes.length > 0;
  }

  function removeMessage() {
    var box = document.getElementById(MESSAGE_ID);
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  // A slow device may mount the app after the message went up: take the message down again then.
  function watchForApp() {
    var root = document.getElementById('root');
    if (!root) return;
    if (typeof window.MutationObserver === 'function') {
      var observer = new window.MutationObserver(function () {
        if (hasApp()) {
          removeMessage();
          observer.disconnect();
        }
      });
      observer.observe(root, { childList: true });
      return;
    }
    var polls = 0;
    (function poll() {
      if (hasApp()) return removeMessage();
      if (++polls < 60) window.setTimeout(poll, 1000);
    })();
  }

  function check() {
    // Never while the app has rendered, so a modern browser does not see a flash.
    if (hasApp()) return;
    if (show()) watchForApp();
  }

  function armSafetyNet() {
    window.setTimeout(check, WAIT_AFTER_LOAD_MS);
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  if (!supported()) {
    onReady(function () {
      hideRoot();
      show();
    });
  } else if (document.readyState === 'complete') {
    armSafetyNet();
  } else {
    // A bundle that never loads (or throws at start) leaves #root empty: the safety net covers it.
    window.addEventListener('load', armSafetyNet);
  }
})();
