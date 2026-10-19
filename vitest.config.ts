import { defineConfig } from 'vitest/config';

// One root config: every package and tool is a Vitest project.
// Coverage thresholds follow plan invariant 4 (80% overall, 100% branches for money, fees and FIFO).
export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'tools/*/src/**'],
      // Worker-thread bodies run outside the main isolate, where V8 coverage can't see them; they are exercised
      // end-to-end by their callers' tests (e.g. test/workers/spreadsheet.test.ts).
      exclude: ['**/*-worker.mjs'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        'packages/core/src/money/**': { branches: 100 },
        'packages/core/src/fees/**': { branches: 100 },
        'packages/core/src/fifo/**': { branches: 100 },
      },
    },
  },
});
