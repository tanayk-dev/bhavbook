// Light ("warm paper") is the default theme; dark is a per-browser preference (direction §9). Storage can be
// unavailable (private windows, blocked site data), so every access is guarded.
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

export function storedTheme(storage: Pick<Storage, 'getItem'> | undefined): Theme {
  try {
    return storage?.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

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
