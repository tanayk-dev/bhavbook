// Local server: vault, import orchestration, recompute and the HTTP API.
export const PACKAGE_NAME = '@bhavbook/server';

export * from './http/index.js';
export * from './vault/index.js';
export * from './import/index.js';
export * from './services/instruments.js';
export * from './recompute/index.js';
export * from './recompute/actions.js';
export * from './services/adjustments.js';
// Corporate actions: only the recompute-safe entry points (the raw service leaves derived state stale).
export * from './recompute/corporate-actions.js';
export { CorporateActionError, type CorporateActionInput } from './services/corporate-actions.js';
