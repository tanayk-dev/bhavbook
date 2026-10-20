/* global window, document */
// Applies the saved theme before the first paint (no flash of the light theme). A plain, blocking script from the
// same origin, so the CSP (script-src 'self') allows it; it only reads one localStorage key.
try {
  if (window.localStorage.getItem('bhavbook.theme') === 'dark')
    document.documentElement.classList.add('dark');
} catch {
  // Storage blocked: the light default stays.
}
