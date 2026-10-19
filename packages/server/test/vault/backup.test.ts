import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  autoBackup,
  BackupError,
  createBackup,
  decodeBhav,
  encodeBhav,
  latestVersion,
  openVault,
  restoreBackup,
} from '../../src/vault/index.js';
import { insertTrade, seedAccount, withTempDir } from './helpers.js';

const APP = '0.0.0-test';

function flipByte(buffer: Buffer, index: number): void {
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0xff, index);
}
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'vault-v0001.bhav',
);

function seededVault(dir: string): { vaultPath: string; db: Database.Database } {
  const vaultPath = path.join(dir, 'vault.db');
  const db = openVault(vaultPath, { appVersion: APP });
  seedAccount(db);
  insertTrade(db, { trade_value_micro: 9_007_199_254_740_993_123n });
  return { vaultPath, db };
}

describe('.bhav container', () => {
  const db = Buffer.from('SQLite format 3\u0000 fake database bytes');
  const meta = { schemaVersion: 1, appVersion: APP, createdAt: '2026-10-19T00:00:00Z' };

  it('round-trips bytes and manifest', () => {
    const decoded = decodeBhav(encodeBhav(db, meta));
    expect(decoded.db.equals(db)).toBe(true);
    expect(decoded.manifest).toMatchObject({ format: 1, ...meta, dbBytes: db.length });
    expect(decoded.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a corrupted database (hash mismatch)', () => {
    const file = encodeBhav(db, meta);
    flipByte(file, file.length - 1);
    expect(() => decodeBhav(file)).toThrow(/checksum/);
  });

  it.each([
    ['wrong magic', (file: Buffer) => Buffer.concat([Buffer.from('NOPE'), file.subarray(4)])],
    ['truncated', (file: Buffer) => file.subarray(0, file.length - 3)],
    ['extra bytes', (file: Buffer) => Buffer.concat([file, Buffer.from('x')])],
    ['too short', () => Buffer.from('BHAV')],
  ])('rejects a %s file', (_label, mutate) => {
    expect(() => decodeBhav(mutate(encodeBhav(db, meta)))).toThrow(BackupError);
  });

  it('rejects a manifest that is not JSON or misses fields', () => {
    const withManifest = (json: string): Buffer => {
      const body = Buffer.from(json, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length, 0);
      return Buffer.concat([Buffer.from('BHAV\u0001', 'latin1'), length, body, db]);
    };
    expect(() => decodeBhav(withManifest('{not json'))).toThrow(/not valid JSON/);
    expect(() => decodeBhav(withManifest('{"format":1}'))).toThrow(/missing required fields/);
    expect(() => decodeBhav(withManifest('null'))).toThrow(/missing required fields/);
  });

  it('rejects an oversized manifest without reading it', () => {
    const header = Buffer.alloc(9);
    header.write('BHAV\u0001', 0, 'latin1');
    header.writeUInt32LE(10 * 1024 * 1024, 5);
    expect(() => decodeBhav(header)).toThrow(/manifest/);
  });
});

describe('createBackup and restoreBackup', () => {
  it('round-trips a vault, including bigint money, and keeps a pre-restore backup', () => {
    withTempDir((dir) => {
      const { vaultPath, db } = seededVault(dir);
      const backupPath = path.join(dir, 'snap.bhav');
      const created = createBackup(db, backupPath, { appVersion: APP });
      expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);
      db.prepare('DELETE FROM trade_row').run();
      db.close();

      const restored = restoreBackup(backupPath, vaultPath, { appVersion: APP });
      expect(restored.schemaVersion).toBe(latestVersion());
      const reopened = openVault(vaultPath, { appVersion: APP });
      const row = reopened.prepare('SELECT trade_value_micro FROM trade_row').get() as {
        trade_value_micro: bigint;
      };
      expect(row.trade_value_micro).toBe(9_007_199_254_740_993_123n);
      reopened.close();
      const backups = readdirSync(`${vaultPath}.backups`);
      expect(backups.some((name) => name.includes('pre-restore'))).toBe(true);
    });
  });

  it('never touches the live vault when the backup is corrupt', () => {
    withTempDir((dir) => {
      const { vaultPath, db } = seededVault(dir);
      const backupPath = path.join(dir, 'snap.bhav');
      createBackup(db, backupPath, { appVersion: APP });
      db.close();
      const bytes = readFileSync(backupPath);
      flipByte(bytes, bytes.length - 10);
      writeFileSync(backupPath, bytes);
      const before = readFileSync(vaultPath);
      expect(() => restoreBackup(backupPath, vaultPath, { appVersion: APP })).toThrow(BackupError);
      expect(readFileSync(vaultPath).equals(before)).toBe(true);
      expect(readdirSync(dir).filter((name) => name.includes('.restore-'))).toEqual([]);
    });
  });

  it('refuses a well-formed backup whose payload is not a SQLite database', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'fake.bhav');
      writeFileSync(
        file,
        encodeBhav(Buffer.from('definitely not sqlite'), {
          schemaVersion: 1,
          appVersion: APP,
          createdAt: 'x',
        }),
      );
      expect(() => restoreBackup(file, path.join(dir, 'vault.db'), { appVersion: APP })).toThrow(/SQLite/);
      expect(existsSync(path.join(dir, 'vault.db'))).toBe(false);
    });
  });

  it('refuses a backup from a newer schema', () => {
    withTempDir((dir) => {
      const { db } = seededVault(dir);
      const raw = path.join(dir, 'raw.db');
      db.prepare('VACUUM INTO ?').run(raw);
      db.close();
      const future = encodeBhav(readFileSync(raw), {
        schemaVersion: 999,
        appVersion: '9.9.9',
        createdAt: 'x',
      });
      const file = path.join(dir, 'future.bhav');
      writeFileSync(file, future);
      expect(() => restoreBackup(file, path.join(dir, 'other.db'), { appVersion: APP })).toThrow(/newer/);
    });
  });

  it('restores the committed v0001 fixture and migrates it forward', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    withTempDir((dir) => {
      const vaultPath = path.join(dir, 'vault.db');
      expect(restoreBackup(FIXTURE, vaultPath, { appVersion: APP }).schemaVersion).toBe(latestVersion());
    });
  });
});

describe('autoBackup', () => {
  it('keeps the newest 10 routine backups and every pre-migration backup', () => {
    withTempDir((dir) => {
      const { vaultPath, db } = seededVault(dir);
      let tick = 0;
      const now = (): Date => new Date(Date.UTC(2026, 9, 19, 0, 0, tick++));
      for (let i = 0; i < 12; i += 1) autoBackup(db, vaultPath, 'pre-import', { appVersion: APP, now });
      for (let i = 0; i < 2; i += 1) autoBackup(db, vaultPath, 'pre-migration', { appVersion: APP, now });
      db.close();
      const names = readdirSync(`${vaultPath}.backups`);
      expect(names.filter((name) => name.includes('pre-import'))).toHaveLength(10);
      expect(names.filter((name) => name.includes('pre-migration'))).toHaveLength(2);
      expect(names.every((name) => /^auto-\d{8}T\d{9}Z-[a-z-]+(-\d+)?\.bhav$/.test(name))).toBe(true);
    });
  });
});
