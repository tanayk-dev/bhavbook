// Corporate actions (ADR-0015, PRD §7.4): entered by the user, applied to the quantity still open at the ex-date.
import type { Bucket } from '../fifo/types.js';

export type CorporateActionType = 'SPLIT' | 'BONUS' | 'CONVERSION' | 'DEMERGER';

export interface CorporateAction {
  readonly id: string;
  readonly type: CorporateActionType;
  readonly isin: string;
  /** CONVERSION: the new ISIN; DEMERGER: the child's ISIN. */
  readonly newIsin: string | null;
  readonly exDateIst: string;
  /** BONUS only: when the bonus shares were allotted (s.55(2)(aa)); defaults to the ex-date. */
  readonly allotmentDateIst: string | null;
  /** New shares per old share is ratioNum / ratioDen (a 1:5 split is 5/1; a 1:1 bonus is 1/1 extra). */
  readonly ratioNum: bigint;
  readonly ratioDen: bigint;
  /** DEMERGER: the child's share of the cost, in basis points (Tata 2025: 3115 for TMCV). */
  readonly costSplitBp: bigint | null;
}

/** Part of an entitlement that isn't a whole share (for a cash-in-lieu sale the user may record). */
export interface Fraction {
  readonly actionId: string;
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** The cost that left with the holding when it got no whole share at all (cash in lieu); else 0. */
  readonly costRemovedMicro: bigint;
}
