// Shared by the import preview and recompute, kept in a leaf module so neither depends on the other's internals.
import type { ParseResult } from '@bhavbook/adapters';
import type { Bucket } from '@bhavbook/core';

export const INCOMPLETE_POSITION = 'incomplete_position';
export const RECOMPUTE_FAILED = 'recompute_failed';

export interface IssueForecast {
  readonly kind: typeof INCOMPLETE_POSITION;
  readonly change: 'create' | 'resolve';
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly orphanQty: string;
}

/** The preview's issue forecaster (a dry-run recompute). */
export type IssueForecaster = (accountId: string, result: ParseResult) => readonly IssueForecast[];
