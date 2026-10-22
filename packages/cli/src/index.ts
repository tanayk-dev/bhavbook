#!/usr/bin/env node
// Local-first trade journal for Indian multi-broker equity traders. Run with npx bhavbook.
import { homedir } from 'node:os';
import open from 'open';
import { main, type CliIo } from './main.js';

export const PACKAGE_NAME = 'bhavbook';

/** Ctrl+C, kill, terminal closed, and Ctrl+Break / console close on Windows. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];

interface Shutdown {
  readonly requested: Promise<void>;
  /** Stops listening, so the process can exit once the server is closed. */
  dispose(): void;
}

/**
 * Resolves on the first shutdown signal. Listening starts before the vault is opened, so a signal during startup
 * still shuts down cleanly (lock released); a second signal exits at once.
 */
function listenForShutdown(): Shutdown {
  let received = false;
  let resolve: () => void = () => undefined;
  const requested = new Promise<void>((done) => {
    resolve = done;
  });
  const onSignal = (): void => {
    if (received) process.exit(130);
    received = true;
    resolve();
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
  return {
    requested,
    dispose: () => {
      for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal);
    },
  };
}

function processIo(shutdown: Shutdown): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    homedir,
    openBrowser: async (url) => {
      await open(url);
    },
    waitForShutdown: () => shutdown.requested,
    onNewLinkRequest: (listener) => {
      // Only someone at an interactive terminal can ask; piped or detached, nothing listens.
      if (!process.stdin.isTTY) return null;
      const onData = (): void => {
        listener();
      };
      process.stdin.on('data', onData);
      return () => {
        process.stdin.off('data', onData);
        // Let the process exit: stdin no longer holds the event loop open.
        process.stdin.pause();
      };
    },
  };
}

if (import.meta.main) {
  const shutdown = listenForShutdown();
  try {
    process.exitCode = await main(process.argv.slice(2), processIo(shutdown));
  } finally {
    shutdown.dispose();
  }
}
