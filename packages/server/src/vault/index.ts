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
  currentVersion,
  latestVersion,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
  type Migration,
  type MigrateOptions,
} from './migrations.js';
export { openVault, type OpenVaultOptions } from './open.js';
