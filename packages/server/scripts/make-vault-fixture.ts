// Writes fixtures/vault-v<NNNN>.bhav: an empty vault at the latest schema version, committed so that every future
// migration can be tested by restoring the previous schema (plan invariant 8). Contains no data at all.
// Usage: pnpm --filter @bhavbook/server exec tsx scripts/make-vault-fixture.ts
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, latestVersion, openVault } from '../src/vault/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = latestVersion();
const out = path.join(root, 'fixtures', `vault-v${String(version).padStart(4, '0')}.bhav`);
const work = mkdtempSync(path.join(tmpdir(), 'bhavbook-vault-fixture-'));
try {
  const db = openVault(path.join(work, 'vault.db'), { appVersion: '0.0.0-fixture' });
  mkdirSync(path.dirname(out), { recursive: true });
  // A fixed timestamp keeps the manifest stable across regenerations.
  createBackup(db, out, '0.0.0-fixture', () => new Date('2026-10-19T00:00:00Z'));
  db.close();
  console.log(`wrote ${path.relative(root, out)} (schema ${version})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
