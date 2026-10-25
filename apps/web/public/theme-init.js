// Applies the saved or system colour scheme before first paint (no flash).
(function () {
  try {
    var saved = localStorage.getItem('pb-theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
