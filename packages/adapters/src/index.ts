// Pure broker file parsers producing canonical rows (no I/O, plan invariant 6).
export const PACKAGE_NAME = '@bhavbook/adapters';

export * from './contract.js';
export * from './detect.js';
export * from './cells.js';
export { zerodhaAdapter } from './zerodha/index.js';
