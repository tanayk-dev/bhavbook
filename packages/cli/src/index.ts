// Local-first trade journal for Indian multi-broker equity traders. Run with npx bhavbook.
import { homedir } from 'node:os';
import open from 'open';
import { main, type CliIo } from './main.js';

export const PACKAGE_NAME = 'bhavbook';

/** Resolves on the first Ctrl+C / SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  homedir,
  openBrowser: async (url) => {
    await open(url);
  },
  waitForShutdown: untilSignal,
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), processIo);
}
