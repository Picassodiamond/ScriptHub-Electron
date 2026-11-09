/* Theme before first paint (no flash): the saved choice, else the operating system's. External file: the app's CSP allows no inline scripts. */
(function () {
  var d = document.documentElement, t = null;
  try { t = localStorage.getItem('sr.theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  d.setAttribute('data-theme', t);
})();
