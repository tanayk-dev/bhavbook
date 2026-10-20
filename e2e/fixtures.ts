// A BhavBook process per test worker: the CLI on a temporary vault, `--no-open`, its launch URL read from stdout.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STARTUP_MS = 30_000;

export interface App {
  /** `http://127.0.0.1:<port>/?t=<token>`: opening it exchanges the token for the session cookie. */
  readonly launch: string;
  readonly origin: string;
}

function launchUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('BhavBook did not start in time'));
    }, STARTUP_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /running at (\S+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`BhavBook exited early (${String(code)})`));
    });
  });
}

export const test = base.extend<object, { app: App }>({
  app: [
    // Playwright reads fixture dependencies from this destructuring pattern: it must stay an object pattern.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bhavbook-e2e-'));
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'packages/cli/src/index.ts', '--vault', path.join(dir, 'vault.db'), '--no-open'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        const launch = await launchUrl(child);
        await use({ launch, origin: new URL(launch).origin });
      } finally {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
