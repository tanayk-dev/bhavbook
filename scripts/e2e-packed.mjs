// Proves the published package works as installed (S16): packs `bhavbook`, installs the tarball with npm into an
// empty directory, runs `npx bhavbook doctor` there, and with `--e2e` runs the Playwright suite against the
// installed CLI (BHAVBOOK_BIN) instead of the source.
//   node scripts/e2e-packed.mjs [--e2e] [playwright args...]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shell.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const [flag, ...playwrightArgs] = process.argv.slice(2);
const work = mkdtempSync(path.join(tmpdir(), 'bhavbook-packed-'));
try {
  const tarball = run('node', [path.join(ROOT, 'scripts', 'pack-cli.mjs'), path.join(work, 'pack')], {
    cwd: ROOT,
  })
    .trim()
    .split(/\r?\n/)
    .at(-1);
  const install = path.join(work, 'install');
  mkdirSync(install);
  writeFileSync(path.join(install, 'package.json'), '{ "private": true }\n');
  run('npm', ['install', tarball, '--no-audit', '--no-fund'], { cwd: install, inherit: true });

  // Every check passes, the web interface and the migrations included (they ship beside the bundle).
  const report = run('npx', ['--no-install', 'bhavbook', 'doctor', '--vault', path.join(work, 'vault.db')], {
    cwd: install,
  });
  process.stdout.write(report);
  for (const check of ['node', 'sqlite', 'schema', 'web']) {
    if (!new RegExp(`^ok\\s+${check}:`, 'm').test(report))
      throw new Error(`doctor did not pass the ${check} check`);
  }

  if (flag === '--e2e') {
    const bin = path.join(install, 'node_modules', 'bhavbook', 'dist', 'index.mjs');
    run('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], {
      cwd: ROOT,
      env: { ...process.env, BHAVBOOK_BIN: bin },
      inherit: true,
    });
  }
} finally {
  // SQLite handles can linger for a moment on Windows after a process ends.
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
