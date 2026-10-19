// Opening-lot suggestions (plan S10a task 2, ADR-0013 "Fill from broker statement"): for an orphan sell, a broker
// statement lot of the same ISIN and quantity, bought on or before the sell, is the missing entry. Suggestions
// only: the user confirms every adjustment.
import type { Bucket } from '../fifo/types.js';

export interface OrphanSummary {
  readonly anchorKey: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly quantity: bigint;
  /** IST date of the orphan sell. */
  readonly dateIst: string;
}

/** A lot from a broker statement (Dhan Tax Report, Zerodha Tax P&L). */
export interface StatementLot {
  readonly statementKey: string;
  readonly isin: string;
  readonly quantity: bigint;
  readonly buyDateIst: string;
  readonly sellDateIst: string | null;
  readonly buyValueMicro: bigint;
}

export interface OpeningLotSuggestion {
  readonly anchorKey: string;
  readonly instrumentKey: string;
  readonly bucket: Exclude<Bucket, 'INTRADAY'>;
  readonly quantity: bigint;
  readonly totalCostMicro: bigint;
  readonly entryDateIst: string;
  readonly statementKey: string;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 0 for a lot sold on the given day (sorted first), 1 otherwise. */
const soldOn = (lot: StatementLot, dateIst: string): number => (lot.sellDateIst === dateIst ? 0 : 1);

/**
 * The best statement lot per orphan: same ISIN and exact quantity, bought on or before the orphan sell; a lot
 * sold on the orphan's day first, then the latest buy, then by statement key (deterministic).
 */
export function suggestOpeningLots(
  orphans: readonly OrphanSummary[],
  lots: readonly StatementLot[],
): OpeningLotSuggestion[] {
  return orphans.flatMap((orphan) => {
    const { bucket } = orphan;
    if (bucket === 'INTRADAY') return [];
    const [best] = lots
      .filter(
        (lot) =>
          lot.isin === orphan.instrumentKey &&
          lot.quantity === orphan.quantity &&
          lot.buyDateIst <= orphan.dateIst,
      )
      .sort(
        (a, b) =>
          soldOn(a, orphan.dateIst) - soldOn(b, orphan.dateIst) ||
          byText(b.buyDateIst, a.buyDateIst) ||
          byText(a.statementKey, b.statementKey),
      );
    if (best === undefined) return [];
    return [
      {
        anchorKey: orphan.anchorKey,
        instrumentKey: orphan.instrumentKey,
        bucket,
        quantity: best.quantity,
        totalCostMicro: best.buyValueMicro,
        entryDateIst: best.buyDateIst,
        statementKey: best.statementKey,
      },
    ];
  });
}
