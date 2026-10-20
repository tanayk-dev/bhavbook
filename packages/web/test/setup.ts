// Testing Library matchers, and a clean DOM after every test (Vitest globals are off).
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no layout: the router's scroll restoration calls scrollTo, which jsdom only logs as unimplemented.
vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

afterEach(() => {
  cleanup();
});
