// The published `bhavbook` package (ADR-0001, S16): one ESM bundle of the CLI, server, adapters and core, plus the
// spreadsheet worker as its own entry (it runs in a worker thread), the SQL migrations and the web build. Only the
// native SQLite binding and the browser opener (which ships a helper script) stay installed dependencies.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'spreadsheet-worker': '../server/src/workers/spreadsheet-worker.mjs',
  },
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: ['better-sqlite3', 'open'],
    // Everything else that may be bundled; a new dependency must be added here deliberately (and to the notices).
    onlyBundle: ['@hono/node-server', 'hono', 'zod', 'csv-parse', 'xlsx'],
  },
  copy: [
    { from: '../server/migrations/*.sql', to: 'dist/migrations' },
    { from: '../web/dist', to: 'dist', rename: 'web' },
  ],
});
