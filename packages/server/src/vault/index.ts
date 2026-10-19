export {
  AUTO_BACKUP_KEEP,
  autoBackup,
  backupDir,
  createBackup,
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
export { openVault, type OpenVaultOptions } from './open.js';
export { APPLICATION_ID, hardenConnection, referenceFingerprint, schemaFingerprint } from './schema.js';
