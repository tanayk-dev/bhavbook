// Fills -> orders (plan S9 task 1): Zerodha exports one row per exchange fill; brokerage is charged per executed
// order (S12a), so fill-granularity rows group by their order id. Order-granularity rows (Dhan) pass through.
import { compareFills, type Side, type TradeFill } from './types.js';

export interface Order {
  readonly key: string;
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly side: Side;
  readonly tradeDateIst: string;
  readonly externalOrderId: string | null;
  readonly quantity: bigint;
  readonly valueMicro: bigint;
  /** In execution order. */
  readonly fills: readonly TradeFill[];
}

function orderKey(fill: TradeFill): string {
  return fill.granularity === 'fill' && fill.externalOrderId !== null
    ? `${fill.accountId}|order|${fill.externalOrderId}`
    : `${fill.accountId}|fill|${fill.id}`;
}

/** Orders in execution order of their first fill (fills are grouped in execution order). */
export function groupFillsIntoOrders(fills: readonly TradeFill[]): Order[] {
  const orders = new Map<string, Order>();
  for (const fill of [...fills].sort(compareFills)) {
    const key = orderKey(fill);
    const seen = orders.get(key);
    orders.set(
      key,
      seen === undefined
        ? {
            key,
            accountId: fill.accountId,
            instrumentKey: fill.instrumentKey,
            side: fill.side,
            tradeDateIst: fill.tradeDateIst,
            externalOrderId: fill.externalOrderId,
            quantity: fill.quantity,
            valueMicro: fill.valueMicro,
            fills: [fill],
          }
        : {
            ...seen,
            quantity: seen.quantity + fill.quantity,
            valueMicro: seen.valueMicro + fill.valueMicro,
            fills: [...seen.fills, fill],
          },
    );
  }
  return [...orders.values()];
}
