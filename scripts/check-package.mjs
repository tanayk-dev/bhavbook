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

// Only these may ship: anything else (a file dropped into packages/web/public, a stray export) fails the pack.
const TOP_LEVEL = ['THIRD-PARTY-NOTICES.md', 'index.mjs', 'migrations', 'spreadsheet-worker.mjs', 'web'];
const WEB_TOP_LEVEL = ['THIRD-PARTY-NOTICES.md', 'assets', 'index.html', 'theme-init.js'];
const WEB_ASSET = /^[\w.-]+\.(js|css|woff2?)$/;
const SHIPPED_TYPE = /\.(mjs|js|css|woff2?|html|sql|md)$/;
// Personal data travels in these (broker exports, vaults, backups, secrets): never in the package.
const DATA = /(\.(csv|xlsx?|pdf|db|bhav|env|json)|fixtures|broker-exports)/i;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
const unexpected = (dir, allowed) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => !allowed.includes(name)) : [];
for (const name of unexpected('dist', TOP_LEVEL))
  problems.push(`dist/${name} is not expected in the package`);
for (const name of unexpected('dist/web', WEB_TOP_LEVEL)) problems.push(`dist/web/${name} is not expected`);
if (existsSync('dist/web/assets')) {
  for (const name of readdirSync('dist/web/assets').filter((file) => !WEB_ASSET.test(file))) {
    problems.push(`dist/web/assets/${name} is not a script, stylesheet or font`);
  }
}
if (existsSync('dist')) {
  for (const file of walk('dist')) {
    if (DATA.test(file)) problems.push(`${file} looks like data and must not ship`);
    else if (!SHIPPED_TYPE.test(file)) problems.push(`${file} is not a type the package ships`);
  }
}

// Every package the bundle may hold has its licence in the notices.
const notices = existsSync('dist/THIRD-PARTY-NOTICES.md')
  ? readFileSync('dist/THIRD-PARTY-NOTICES.md', 'utf8')
  : '';
const config = readFileSync('tsdown.config.ts', 'utf8');
const onlyBundle = /onlyBundle:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
const bundled = [...onlyBundle.matchAll(/'([^']+)'/g)].map((match) => match[1]);
if (bundled.length === 0)
  problems.push('tsdown.config.ts has no deps.onlyBundle list to check the notices against');
for (const name of bundled) {
  if (!notices.includes(`### ${name} `)) problems.push(`THIRD-PARTY-NOTICES.md has no licence for ${name}`);
}

if (problems.length > 0) {
  console.error('The bhavbook package is not ready to pack:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
