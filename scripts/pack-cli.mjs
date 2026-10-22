// Builds and packs the published `bhavbook` package (S16): the web build, the CLI bundle (tsdown), the licences of
// everything bundled, the README and the licence, then `pnpm pack`, whose prepack guard checks the result.
//   node scripts/pack-cli.mjs [out-dir]   (default: .pack/) — prints the tarball's path last.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'packages', 'cli');
const PNPM_STORE = path.join(ROOT, 'node_modules', '.pnpm');

/** Runs pnpm through the shell (a .cmd shim on Windows); every argument is quoted, as paths may hold spaces. */
function pnpm(args, cwd = ROOT) {
  const command = ['pnpm', ...args.map((arg) => JSON.stringify(arg))].join(' ');
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

const read = (file) => readFileSync(file, 'utf8').trim();
const licenceFiles = (dir) =>
  readdirSync(dir).filter((name) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(name));

/** A bundled package's licence and NOTICE texts, as found in its installed directory. */
function packageNotice(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = licenceFiles(dir);
  const texts = files.map((name) => read(path.join(dir, name)));
  if (texts.length === 0) throw new Error(`${manifest.name} has no licence file to ship`);
  return `### ${manifest.name} ${manifest.version} (${manifest.license})\n\n${texts.map((text) => `\`\`\`\n${text}\n\`\`\``).join('\n\n')}`;
}

/** The packages a bundle holds, read from rolldown's region comments (`node_modules/.pnpm/<id>/node_modules/<name>`). */
function bundledDirs(files) {
  const dirs = new Set();
  for (const file of files) {
    const pattern = /node_modules\/\.pnpm\/[^/\s]+\/node_modules\/(?:@[^/\s]+\/)?[^/\s]+/g;
    for (const match of read(file).matchAll(pattern)) dirs.add(path.join(ROOT, match[0]));
  }
  return [...dirs].sort();
}

/** NOTICE files of the web build's packages (Vite's notices carry the licences only; Apache-2.0 asks for both). */
function webNotices(viteNotices) {
  const notices = [];
  for (const [, name, version] of viteNotices.matchAll(/^## (\S+) - (\S+) \(/gm)) {
    const prefix = `${name.replace('/', '+')}@${version}`;
    const id = readdirSync(PNPM_STORE).find((entry) => entry === prefix || entry.startsWith(`${prefix}_`));
    const dir = id === undefined ? undefined : path.join(PNPM_STORE, id, 'node_modules', name);
    const notice = dir === undefined ? undefined : licenceFiles(dir).find((file) => /^notice/i.test(file));
    if (notice !== undefined)
      notices.push(`### ${name} ${version}: NOTICE\n\n\`\`\`\n${read(path.join(dir, notice))}\n\`\`\``);
  }
  return notices;
}

function writeNotices() {
  const dist = path.join(CLI, 'dist');
  const server = bundledDirs(['index.mjs', 'spreadsheet-worker.mjs'].map((name) => path.join(dist, name)));
  const viteNotices = read(path.join(dist, 'web', 'THIRD-PARTY-NOTICES.md'));
  const sections = [
    '# Third-party notices',
    'The `bhavbook` package bundles the following open-source software. Its own code is MIT-licensed (see LICENSE).',
    '## The server and command line (`dist/index.mjs`, `dist/spreadsheet-worker.mjs`)',
    ...server.map(packageNotice),
    '## The web interface (`dist/web`)',
    viteNotices.replace(/^#/gm, '##'),
    ...webNotices(viteNotices),
  ];
  writeFileSync(path.join(dist, 'THIRD-PARTY-NOTICES.md'), `${sections.join('\n\n')}\n`);
}

const out = path.resolve(process.argv[2] ?? path.join(ROOT, '.pack'));
mkdirSync(out, { recursive: true });
pnpm(['--filter', '@bhavbook/web', 'build']);
pnpm(['--filter', 'bhavbook', 'build']);
writeNotices();
for (const file of ['README.md', 'LICENSE']) copyFileSync(path.join(ROOT, file), path.join(CLI, file));
const before = new Set(readdirSync(out));
pnpm(['pack', '--pack-destination', out], CLI);
const tarball =
  readdirSync(out).find((name) => name.endsWith('.tgz') && !before.has(name)) ??
  readdirSync(out).find((name) => name.startsWith('bhavbook-') && name.endsWith('.tgz'));
if (tarball === undefined || !existsSync(path.join(out, tarball)))
  throw new Error('pnpm pack wrote no tarball');
process.stdout.write(`${path.join(out, tarball)}\n`);
