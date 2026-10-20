// Light ("warm paper") is the default theme; dark is a per-browser preference (direction §9). public/theme-init.js
// applies a saved dark preference before the first paint; the toggle reads the live state from the page. Storage
// can be unavailable (private windows, blocked site data), so every access is guarded.
export type Theme = 'light' | 'dark';

const KEY = 'bhavbook.theme';

/** The browser's localStorage, or undefined where access throws. */
export function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The theme the page is showing right now. */
export function currentTheme(root: Pick<HTMLElement, 'classList'>): Theme {
  return root.classList.contains('dark') ? 'dark' : 'light';
}

/** Shows a theme and remembers the user's choice (only on an explicit choice, never on load). */
export function applyTheme(
  theme: Theme,
  root: Pick<HTMLElement, 'classList'>,
  storage: Pick<Storage, 'setItem'> | undefined,
): void {
  root.classList.toggle('dark', theme === 'dark');
  try {
    storage?.setItem(KEY, theme);
  } catch {
    // The preference just won't persist.
  }
}
