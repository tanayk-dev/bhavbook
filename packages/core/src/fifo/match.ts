// FIFO lot matching (ADR-0011, PRD §7.1) per (account, instrument, bucket), in execution order.
// DELIVERY / MTF: sells consume the oldest open buys; a sell beyond the holding is an orphan, never an invented
// buy (PRD §3.2 invariant 5). INTRADAY: each day's buys and sells pair in time order on each side (netting made
// the day's quantities equal, so a sell may come first: an intraday short). Quantities are matched first; then each
// allocation's value is split across its pieces by quantity with the largest-remainder rule, so values are
// conserved to the micro-rupee.
import { splitByWeight } from '../money/allocate.js';
import {
  compareAllocations,
  groupBy,
  sortedEntries,
  type FillAllocation,
  type Lot,
  type MatchResult,
  type Orphan,
} from './types.js';

/** A matched quantity before values are assigned: buy -> sell (or still open), or an orphan sell. */
type Piece =
  | {
      readonly kind: 'lot';
      readonly buy: FillAllocation;
      readonly sell: FillAllocation | null;
      readonly quantity: bigint;
    }
  | { readonly kind: 'orphan'; readonly sell: FillAllocation; readonly quantity: bigint };

/** A piece with its share of the buy's and the sell's value (filled in by assignValues). */
interface Valued {
  readonly piece: Piece;
  buyValue: bigint;
  sellValue: bigint;
}

interface Open {
  readonly allocation: FillAllocation;
  remaining: bigint;
}

/** Matches one sell against the open buys, oldest first; any rest is an orphan piece. */
function consume(open: Open[], sell: FillAllocation, pieces: Piece[]): void {
  let remaining = sell.quantity;
  for (let head = open[0]; remaining > 0n && head !== undefined; head = open[0]) {
    const quantity = head.remaining < remaining ? head.remaining : remaining;
    pieces.push({ kind: 'lot', buy: head.allocation, sell, quantity });
    head.remaining -= quantity;
    remaining -= quantity;
    if (head.remaining === 0n) open.shift();
  }
  if (remaining > 0n) pieces.push({ kind: 'orphan', sell, quantity: remaining });
}

function openPieces(open: readonly Open[]): Piece[] {
  return open.map(({ allocation, remaining }) => ({
    kind: 'lot',
    buy: allocation,
    sell: null,
    quantity: remaining,
  }));
}

/** Pairs a day's buys and sells in time order on each side (intraday: a sell may precede its buy). */
function pairInOrder(buys: readonly FillAllocation[], sells: readonly FillAllocation[]): Piece[] {
  const pieces: Piece[] = [];
  const open: Open[] = buys.map((allocation) => ({ allocation, remaining: allocation.quantity }));
  for (const sell of sells) consume(open, sell, pieces);
  return [...pieces, ...openPieces(open)];
}

/** Holding-aware FIFO: a sell only matches buys executed before it. */
function matchHeld(allocations: readonly FillAllocation[]): Piece[] {
  const pieces: Piece[] = [];
  const open: Open[] = [];
  for (const allocation of allocations) {
    if (allocation.side === 'BUY') open.push({ allocation, remaining: allocation.quantity });
    else consume(open, allocation, pieces);
  }
  return [...pieces, ...openPieces(open)];
}

function matchIntraday(allocations: readonly FillAllocation[]): Piece[] {
  return sortedEntries(groupBy(allocations, (allocation) => allocation.tradeDateIst)).flatMap(([, day]) =>
    pairInOrder(
      day.filter((allocation) => allocation.side === 'BUY'),
      day.filter((allocation) => allocation.side === 'SELL'),
    ),
  );
}

/** Gives every piece its share of its buy's and its sell's value (largest remainder per allocation). */
function assignValues(pieces: readonly Piece[]): Valued[] {
  const valued: Valued[] = pieces.map((piece) => ({ piece, buyValue: 0n, sellValue: 0n }));
  const uses = new Map<string, { allocation: FillAllocation; side: 'buy' | 'sell'; pieces: Valued[] }>();
  const use = (allocation: FillAllocation, side: 'buy' | 'sell', entry: Valued): void => {
    const seen = uses.get(allocation.key);
    if (seen === undefined) uses.set(allocation.key, { allocation, side, pieces: [entry] });
    else seen.pieces.push(entry);
  };
  for (const entry of valued) {
    if (entry.piece.kind === 'lot') use(entry.piece.buy, 'buy', entry);
    if (entry.piece.sell !== null) use(entry.piece.sell, 'sell', entry);
  }
  for (const { allocation, side, pieces: shares } of uses.values()) {
    for (const { item, part } of splitByWeight(
      allocation.valueMicro,
      shares,
      (entry) => entry.piece.quantity,
    )) {
      if (side === 'buy') item.buyValue = part;
      else item.sellValue = part;
    }
  }
  return valued;
}

export function matchFifo(allocations: readonly FillAllocation[]): MatchResult {
  const groups = groupBy(allocations, (allocation) =>
    [allocation.accountId, allocation.instrumentKey, allocation.bucket].join('\u0000'),
  );
  const pieces = sortedEntries(groups).flatMap(([, group]) => {
    const ordered = [...group].sort(compareAllocations);
    return ordered[0]?.bucket === 'INTRADAY' ? matchIntraday(ordered) : matchHeld(ordered);
  });
  const lots: Lot[] = [];
  const orphans: Orphan[] = [];
  for (const { piece, buyValue, sellValue } of assignValues(pieces)) {
    if (piece.kind === 'orphan') {
      const { sell } = piece;
      orphans.push({
        allocation: sell.key,
        accountId: sell.accountId,
        instrumentKey: sell.instrumentKey,
        bucket: sell.bucket,
        quantity: piece.quantity,
        valueMicro: sellValue,
        atUtc: sell.executedAtUtc,
        dateIst: sell.tradeDateIst,
      });
      continue;
    }
    const { buy, sell } = piece;
    lots.push({
      accountId: buy.accountId,
      instrumentKey: buy.instrumentKey,
      bucket: buy.bucket,
      entry: buy.key,
      exit: sell?.key ?? null,
      quantity: piece.quantity,
      entryValueMicro: buyValue,
      exitValueMicro: sell === null ? null : sellValue,
      entryDateIst: buy.tradeDateIst,
      exitDateIst: sell?.tradeDateIst ?? null,
    });
  }
  return { lots, orphans };
}
