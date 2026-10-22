// The `bhavbook` package's prepack guard (S16): refuses to pack a bundle that would install but not work. Runs in
// packages/cli. Build first with `node scripts/pack-cli.mjs` (it builds the web app, the bundle and the docs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join('..', 'server', 'migrations');

const problems = [];
const need = (file, why) => {
  if (!existsSync(file)) problems.push(`${file} is missing (${why})`);
};

need('dist/index.mjs', 'the CLI bundle');
need('dist/spreadsheet-worker.mjs', 'the spreadsheet worker');
need('dist/web/index.html', 'the web interface');
need('README.md', 'the npm page');
need('LICENSE', 'the licence');
need('dist/THIRD-PARTY-NOTICES.md', 'the licences of bundled code');

if (
  existsSync('dist/index.mjs') &&
  !readFileSync('dist/index.mjs', 'utf8').startsWith('#!/usr/bin/env node\n')
) {
  problems.push('dist/index.mjs does not start with a node shebang');
}

const sql = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.sql')) : []);
const shipped = sql('dist/migrations');
const source = sql(MIGRATIONS);
if (shipped.join() !== source.join()) {
  problems.push(
    `dist/migrations has ${String(shipped.length)} migrations; the server has ${String(source.length)}`,
  );
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
if (existsSync('dist')) {
  for (const file of walk('dist')) {
    if (/\.(map|ts|tsx)$/.test(file)) problems.push(`${file} should not ship (source or source map)`);
  }
}

if (problems.length > 0) {
  console.error('The bhavbook package is not ready to pack:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
