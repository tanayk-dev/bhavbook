// Shared by the import preview and recompute, kept in a leaf module so neither depends on the other's internals.
import type { ParseResult } from '@bhavbook/adapters';
import type { Bucket } from '@bhavbook/core';

export const INCOMPLETE_POSITION = 'incomplete_position';
export const RECOMPUTE_FAILED = 'recompute_failed';
/** An INCOMPLETE position a broker-statement lot could fill (ADR-0013 "Fill from broker statement"). */
export const FILL_FROM_STATEMENT = 'fill_from_statement';
/** An opening lot real fills now cover (E7). */
export const OPENING_LOT_REDUNDANT = 'opening_lot_redundant';
/** A pattern that suggests a corporate action the user hasn't entered (ADR-0015: never applied automatically). */
export const CORPORATE_ACTION_SUSPECTED = 'corporate_action_suspected';
/** A fraction of a share a corporate action left (paid as cash in lieu). */
export const CASH_IN_LIEU = 'cash_in_lieu';
/** Trades with no fee rule version in force on their trade date: their charges are unknown. */
export const FEES_UNRATED = 'fees_unrated';

export interface IssueForecast {
  readonly kind: typeof INCOMPLETE_POSITION;
  readonly change: 'create' | 'resolve';
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly orphanQty: string;
}

/** The preview's issue forecaster (a dry-run recompute). */
export type IssueForecaster = (accountId: string, result: ParseResult) => readonly IssueForecast[];
