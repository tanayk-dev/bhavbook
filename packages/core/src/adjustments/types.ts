// Adjustments (ADR-0013, PRD §5.5): user-confirmed, revertible facts layered over imported rows, never edits to
// them. Only active adjustments reach reconstruction; reverted and superseded ones are simply left out.
import type { Bucket } from '../fifo/types.js';

/** Shares held before the imported history starts (E6), or from a broker statement (E11). */
export interface OpeningLot {
  readonly id: string;
  readonly kind: 'opening_lot';
  readonly accountId: string;
  readonly instrumentKey: string;
  /** Holdings only: an intraday position can't be opened by a lot carried in from before. */
  readonly bucket: Exclude<Bucket, 'INTRADAY'>;
  readonly quantity: bigint;
  readonly totalCostMicro: bigint;
  /** Exactly one of these: the acquisition date, or "held before this date" when the date is unknown. */
  readonly entryDateIst?: string | undefined;
  readonly beforeDateIst?: string | undefined;
}

/** Leaves a position out of analytics (the user's EXCLUDED flag). */
export interface Exclusion {
  readonly id: string;
  readonly kind: 'exclude';
  readonly accountId: string;
  readonly anchorKey: string;
}

/** Re-buckets a whole (account, instrument, IST date). */
export interface ProductOverrideAdjustment {
  readonly id: string;
  readonly kind: 'product_override';
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly tradeDateIst: string;
  readonly bucket: Bucket;
}

export type Adjustment = OpeningLot | Exclusion | ProductOverrideAdjustment;
