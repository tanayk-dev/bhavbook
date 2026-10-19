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
  const builders = new Map<
    string,
    { first: TradeFill; fills: TradeFill[]; quantity: bigint; valueMicro: bigint }
  >();
  for (const fill of [...fills].sort(compareFills)) {
    const key = orderKey(fill);
    const builder = builders.get(key);
    if (builder === undefined) {
      builders.set(key, { first: fill, fills: [fill], quantity: fill.quantity, valueMicro: fill.valueMicro });
    } else {
      builder.fills.push(fill);
      builder.quantity += fill.quantity;
      builder.valueMicro += fill.valueMicro;
    }
  }
  return [...builders.entries()].map(([key, { first, fills: grouped, quantity, valueMicro }]) => ({
    key,
    accountId: first.accountId,
    instrumentKey: first.instrumentKey,
    side: first.side,
    tradeDateIst: first.tradeDateIst,
    externalOrderId: first.externalOrderId,
    quantity,
    valueMicro,
    fills: grouped,
  }));
}
