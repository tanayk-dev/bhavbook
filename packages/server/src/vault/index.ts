export {
  AUTO_BACKUP_KEEP,
  autoBackup,
  backupDir,
  createBackup,
  isVaultFile,
  MAX_BACKUP_BYTES,
  restoreBackup,
  type BackupOptions,
  type BackupReason,
  type RestoreOptions,
} from './backup.js';
export {
  decodeBhav,
  encodeBhav,
  MAX_MANIFEST_BYTES,
  type BackupManifest,
  type BackupMeta,
} from './container.js';
export { BackupError, VaultError } from './errors.js';
export {
  appliedMigrations,
  assertHistoryMatches,
  currentVersion,
  latestVersion,
  loadMigrations,
  migrate,
  migrationChecksum,
  MIGRATIONS_DIR,
  type AppliedMigration,
  type Migration,
  type MigrateOptions,
} from './migrations.js';
export { openVault, openVaultReadOnly, type OpenVaultOptions } from './open.js';
export { APPLICATION_ID, hardenConnection, referenceFingerprint, schemaFingerprint } from './schema.js';
export { acquireVaultLock, lockPath, STALE_LOCK_MS, type VaultLock } from './lock.js';
export { recoverInterruptedRestore, type RecoveryResult } from './recover.js';
export { ensureBackupDir } from './backup.js';
export { backupPath, listBackups, manualBackup, type BackupEntry } from './catalog.js';
