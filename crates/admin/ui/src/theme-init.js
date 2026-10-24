// Applies the saved theme before the first paint, so a light-mode user does
// not see the dark default flash in. A classic blocking script loaded from
// <head> (the CSP forbids inline scripts); mode-watcher takes over once the
// app mounts. Same storage key and default as <ModeWatcher> in App.svelte.
;(function () {
  var root = document.documentElement
  var mode = 'dark'
  try {
    mode = localStorage.getItem('mode-watcher-mode') || 'dark'
  } catch (e) {
    // Storage blocked: keep the default.
  }
  var light = mode === 'light' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  root.classList.toggle('dark', !light)
  root.style.colorScheme = light ? 'light' : 'dark'
})()
