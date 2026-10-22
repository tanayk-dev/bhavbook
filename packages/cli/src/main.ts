// The `bhavbook` command (ADR-0001). Serves the local app by default; `backup`, `restore` and `doctor` work on the
// vault directly. Every command that can change the vault holds the single-instance lock, and errors print fixed
// messages only (never file contents or stack traces).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import {
  acquireVaultLock,
  createBackup,
  createLogger,
  isVaultFile,
  loadMigrations,
  openVault,
  openVaultReadOnly,
  recoverInterruptedRestore,
  restoreBackup,
  startServer,
  VaultError,
  type RunningServer,
} from '@bhavbook/server';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  homedir(): string;
  openBrowser(url: string): Promise<void>;
  /** Resolves when the server should stop (Ctrl+C in the real CLI). */
  waitForShutdown(server: RunningServer): Promise<void>;
  /**
   * Calls `listener` whenever the person asks for a new launch link (Enter in an interactive terminal). Returns a
   * way to stop listening, or null when there is no one to ask (output piped, as in the browser tests).
   */
  onNewLinkRequest(listener: () => void): (() => void) | null;
}

const MIN_NODE: readonly [number, number] = [24, 11];

/**
 * Installed, this code runs from the bundle (`dist/index.mjs`, built by tsdown) with the web build in `dist/web`; in
 * the workspace it runs from source and the web build is `packages/web/dist`.
 */
const BUNDLED = !/\.[cm]?tsx?$/.test(import.meta.url);

/** The web build; without it the server shows a placeholder page. */
const WEB_BUILD = fileURLToPath(new URL(BUNDLED ? './web/' : '../../web/dist/', import.meta.url));

const USAGE = `usage:
  bhavbook [--vault <path>] [--port <n>] [--no-open]   start BhavBook and open it in your browser
  bhavbook backup <out.bhav> [--vault <path>] [--force] write a backup of the vault
  bhavbook restore <file.bhav> [--vault <path>]        replace the vault with a backup
  bhavbook doctor [--vault <path>]                     check Node, SQLite and the vault`;

class UsageError extends Error {}

// `src/` and `dist/` both sit next to package.json.
const APP_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export function defaultVaultPath(home: string): string {
  return path.join(home, 'BhavBook', 'vault.db');
}

export function checkNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version);
  if (!match) return false;
  const major = Number.parseInt(match[1] ?? '0', 10);
  const minor = Number.parseInt(match[2] ?? '0', 10);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

interface Parsed {
  readonly command: 'serve' | 'backup' | 'restore' | 'doctor' | 'help';
  readonly file: string | null;
  readonly vault: string;
  readonly port: number;
  readonly open: boolean;
  readonly force: boolean;
}

function parse(argv: readonly string[], io: CliIo): Parsed {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        vault: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        force: { type: 'boolean' },
      },
    }));
  } catch {
    throw new UsageError('unknown option');
  }
  const vault = path.resolve(values.vault ?? defaultVaultPath(io.homedir()));
  const help = { vault, port: 0, open: false, force: false, command: 'help', file: null } as const;
  if (values.help === true) return help;
  const portText = values.port ?? '0';
  if (!/^\d{1,5}$/.test(portText) || Number.parseInt(portText, 10) > 65_535) throw new UsageError('bad port');
  const base = {
    vault,
    port: Number.parseInt(portText, 10),
    open: values['no-open'] !== true,
    force: values.force === true,
  };
  const [command, file, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError('too many arguments');
  if (command === undefined) return { ...base, command: 'serve', file: null };
  if (command === 'doctor' && file === undefined) return { ...base, command, file: null };
  if ((command === 'backup' || command === 'restore') && file !== undefined) {
    return { ...base, command, file: path.resolve(file) };
  }
  throw new UsageError('unknown command');
}

/** Runs `work` holding the vault lock, after recovering from an interrupted restore. */
async function withVaultLock<T>(vault: string, io: CliIo, work: () => Promise<T> | T): Promise<T> {
  mkdirSync(path.dirname(vault), { recursive: true, mode: 0o700 });
  const lock = acquireVaultLock(vault);
  try {
    const recovery = recoverInterruptedRestore(vault);
    if (recovery.restoredOldVault) io.err('Recovered the vault from an interrupted restore.');
    return await work();
  } finally {
    lock.release();
  }
}

async function serveCommand(args: Parsed, io: CliIo): Promise<number> {
  return withVaultLock(args.vault, io, async () => {
    // A restore from the UI replaces the connection; whichever one is current is closed at shutdown.
    let db = openVault(args.vault, { appVersion: APP_VERSION });
    try {
      const token = randomBytes(32).toString('base64url');
      const logger = createLogger((line) => {
        io.err(line);
      });
      if (!existsSync(WEB_BUILD))
        io.err('The web interface is not built yet: run pnpm --filter @bhavbook/web build.');
      const backups = {
        vaultPath: args.vault,
        appVersion: APP_VERSION,
        reopen: () => openVault(args.vault, { appVersion: APP_VERSION }),
        onReopen: (next: Database.Database) => {
          db = next;
        },
      };
      const server = await startServer({
        token,
        logger,
        vault: db,
        backups,
        port: args.port,
        staticRoot: WEB_BUILD,
      });
      try {
        io.out(`BhavBook is running at ${server.url}`);
        // The link opens a session once (ADR-0002); a closed browser needs a new one.
        const openLink = async (url: string): Promise<void> => {
          await io.openBrowser(url).catch(() => {
            io.err(`Could not open a browser. Open ${url} in your browser.`);
          });
        };
        const stopListening = io.onNewLinkRequest(() => {
          const url = server.newLaunchUrl();
          io.out(`New link: ${url}`);
          void openLink(url);
        });
        if (stopListening !== null) {
          io.out('The link works once. If you close the browser, press Enter here for a new one.');
        }
        io.out('Press Ctrl+C to stop.');
        try {
          if (args.open) await openLink(server.url);
          await io.waitForShutdown(server);
        } finally {
          stopListening?.();
        }
      } finally {
        await server.close();
      }
    } finally {
      db.close();
    }
    return 0;
  });
}

/** Read-only, so it is safe while the server runs; it never creates, migrates or overwrites the vault. */
function backupCommand(args: Parsed, out: string, io: CliIo): number {
  if (isVaultFile(out, args.vault))
    throw new VaultError('refusing to write a backup over the vault or its files');
  if (existsSync(out) && !args.force) {
    throw new VaultError('the output file already exists; pass --force to overwrite it');
  }
  if (!existsSync(args.vault)) throw new VaultError('there is no vault at that path');
  const db = openVaultReadOnly(args.vault);
  try {
    const result = createBackup(db, out, { appVersion: APP_VERSION });
    io.out(`Backup written to ${result.path} (sha256 ${result.sha256}).`);
  } finally {
    db.close();
  }
  return 0;
}

async function restoreCommand(args: Parsed, file: string, io: CliIo): Promise<number> {
  return withVaultLock(args.vault, io, () => {
    const { schemaVersion } = restoreBackup(file, args.vault, { appVersion: APP_VERSION });
    io.out(`Vault restored (schema version ${String(schemaVersion)}).`);
    return 0;
  });
}

function doctorCommand(args: Parsed, io: CliIo): number {
  const results: (boolean | null)[] = [];
  const report = (ok: boolean | null, check: string, detail: string): void => {
    results.push(ok);
    io.out(`${ok === null ? 'skip' : ok ? 'ok  ' : 'FAIL'}  ${check}: ${detail}`);
  };
  const node = process.versions.node;
  report(checkNodeVersion(node), 'node', `${node} (needs ${MIN_NODE.join('.')} or newer)`);
  try {
    const memory = new Database(':memory:');
    const version = memory.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    memory.close();
    report(true, 'sqlite', `better-sqlite3 loads, SQLite ${version.v}`);
  } catch {
    report(false, 'sqlite', 'better-sqlite3 does not load on this machine');
  }
  try {
    report(true, 'schema', `${String(loadMigrations().length)} migrations`);
  } catch {
    report(false, 'schema', 'the migration files are missing or unreadable');
  }
  if (existsSync(path.join(WEB_BUILD, 'index.html'))) report(true, 'web', 'the interface is built');
  else if (BUNDLED) report(false, 'web', 'the interface is missing from this install');
  else report(null, 'web', 'not built (pnpm --filter @bhavbook/web build)');
  if (!existsSync(args.vault)) {
    report(null, 'vault', 'not created yet');
    return results.includes(false) ? 1 : 0;
  }
  try {
    const db = new Database(args.vault, { readonly: true, fileMustExist: true });
    try {
      const result = db.pragma('integrity_check', { simple: true });
      report(result === 'ok', 'vault', result === 'ok' ? 'integrity check passed' : 'integrity check failed');
    } finally {
      db.close();
    }
  } catch {
    report(false, 'vault', 'the file is not a readable SQLite database');
  }
  return results.includes(false) ? 1 : 0;
}

async function run(args: Parsed, io: CliIo): Promise<number> {
  switch (args.command) {
    case 'help':
      io.out(USAGE);
      return 0;
    case 'serve':
      return serveCommand(args, io);
    case 'backup':
      return backupCommand(args, args.file ?? '', io);
    case 'restore':
      return restoreCommand(args, args.file ?? '', io);
    case 'doctor':
      return doctorCommand(args, io);
  }
}

/** Exit codes: 0 ok, 1 failure, 2 usage error. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let args: Parsed;
  try {
    args = parse(argv, io);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(USAGE);
    return 2;
  }
  try {
    return await run(args, io);
  } catch (error) {
    // VaultError/BackupError messages are fixed strings (ADR-0019); anything else is reported by name only.
    io.err(error instanceof VaultError ? `Error: ${error.message}` : 'Error: unexpected failure');
    return 1;
  }
}
