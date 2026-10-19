import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Every project's tests fail on any non-loopback network connection (plan invariant 5).
const NO_OUTBOUND = path.join(ROOT, 'scripts', 'no-outbound-sockets.ts');

// Per-package test settings. Core runs in a non-IST timezone so any accidental use of the machine timezone fails
// (ADR-0005).
const OVERRIDES: Readonly<Record<string, TestProjectInlineConfiguration['test']>> = {
  '@bhavbook/core': { env: { TZ: 'America/New_York' } },
};

/** One project per package and tool, inheriting this root config (setup files) via `extends: true`. */
function projects(): TestProjectInlineConfiguration[] {
  return ['packages', 'tools'].flatMap((base) =>
    readdirSync(path.join(ROOT, base))
      .map((name) => path.join(ROOT, base, name))
      .filter((dir) => existsSync(path.join(dir, 'package.json')))
      .map((dir) => {
        const { name } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string };
        return { extends: true, test: { name, root: dir, ...OVERRIDES[name] } };
      }),
  );
}

// One root config: every package and tool is a Vitest project.
// Coverage thresholds follow plan invariant 4 (80% overall, 100% branches for money, fees and FIFO).
export default defineConfig({
  test: {
    projects: projects(),
    passWithNoTests: true,
    // Shared CI runners (Windows especially) can be several times slower than a laptop.
    testTimeout: 30_000,
    setupFiles: [NO_OUTBOUND],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'tools/*/src/**'],
      // Worker-thread bodies run outside the main isolate, where V8 coverage can't see them; they are exercised
      // end-to-end by their callers' tests. Keep them to a thin shell over an in-process, covered module.
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
        'packages/core/src/corporate-actions/**': { branches: 100 },
      },
    },
  },
});
