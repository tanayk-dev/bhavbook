// A BhavBook process per test (a fresh vault each time): the CLI on a temporary vault, `--no-open`, its launch URL read from stdout.
// Its stderr (one log line per request) is drained continuously, so the pipe never fills, and kept for diagnosis
// when startup fails.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STARTUP_MS = 30_000;
const STDERR_KEPT = 4_000;

export interface App {
  /** `http://127.0.0.1:<port>/?t=<token>`: opening it exchanges the token for the session cookie. */
  readonly launch: string;
  readonly origin: string;
}

function launchUrl(child: ChildProcess, stderr: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`BhavBook did not start in time:\n${stderr()}`));
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
      reject(new Error(`BhavBook exited early (${String(code)}):\n${stderr()}`));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

export const test = base.extend<{ app: App }>({
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
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT);
      });
      try {
        const launch = await launchUrl(child, () => stderr);
        await use({ launch, origin: new URL(launch).origin });
      } finally {
        await stop(child);
        // SQLite handles can linger for a moment on Windows after the process ends.
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    { scope: 'test' },
  ],
});

export { expect } from '@playwright/test';
