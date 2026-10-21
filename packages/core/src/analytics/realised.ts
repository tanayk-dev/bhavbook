// Realisation views (S15a, PRD §9.1): a closed lot is a realisation event dated by its exit fill's IST date, so a
// partial exit counts in the month and on the day it happened (calendar heatmap, equity curve, monthly P&L).
import { splitByWeight } from '../money/allocate.js';

export interface RealisedLot {
  readonly positionId: string;
  readonly exitDateIst: string;
  /** exit value − entry value. */
  readonly grossMicro: bigint;
  /** The lot's share of its entry and exit fills' charges (apportionLotCharges). */
  readonly chargesMicro: bigint;
}

export interface Realised {
  readonly lots: number;
  readonly grossMicro: bigint;
  readonly chargesMicro: bigint;
  readonly netMicro: bigint;
}

/** Realised P&L per exit day or month, in date order. */
export function realisedBy(lots: readonly RealisedLot[], by: 'day' | 'month'): Map<string, Realised> {
  const totals = new Map<string, Realised>();
  const ordered = lots
    .slice()
    .sort((a, b) => (a.exitDateIst < b.exitDateIst ? -1 : a.exitDateIst > b.exitDateIst ? 1 : 0));
  for (const lot of ordered) {
    const key = by === 'day' ? lot.exitDateIst : lot.exitDateIst.slice(0, 7);
    const total = totals.get(key) ?? { lots: 0, grossMicro: 0n, chargesMicro: 0n, netMicro: 0n };
    totals.set(key, {
      lots: total.lots + 1,
      grossMicro: total.grossMicro + lot.grossMicro,
      chargesMicro: total.chargesMicro + lot.chargesMicro,
      netMicro: total.netMicro + lot.grossMicro - lot.chargesMicro,
    });
  }
  return totals;
}

export interface LotLink {
  readonly lotKey: string;
  /** The entry allocation's key. */
  readonly entry: string;
  /** The exit allocation's key; null while the lot is open. */
  readonly exit: string | null;
  readonly quantity: bigint;
}

export interface LotCharges {
  readonly shares: Map<string, bigint>;
  /** Charges of allocations no lot holds (an orphaned sell has no lot): kept visible, never dropped. */
  readonly unallocatedMicro: bigint;
}

/**
 * Each allocation's charges spread over the lots it belongs to by quantity, with exact sums (largest remainder):
 * a lot's charge is its share of its entry fill's charges plus its share of its exit fill's. Pass every lot of
 * the positions concerned, open ones too, or a fill's whole charge lands on the lots passed.
 */
export function apportionLotCharges(
  allocationCharges: ReadonlyMap<string, bigint>,
  lots: readonly LotLink[],
): LotCharges {
  const byAllocation = new Map<string, LotLink[]>();
  for (const lot of lots) {
    for (const key of lot.exit === null ? [lot.entry] : [lot.entry, lot.exit]) {
      const members = byAllocation.get(key);
      if (members === undefined) byAllocation.set(key, [lot]);
      else members.push(lot);
    }
  }
  const shares = new Map(lots.map((lot) => [lot.lotKey, 0n]));
  let unallocatedMicro = 0n;
  for (const [key, charge] of allocationCharges) {
    const members = byAllocation.get(key);
    if (members === undefined) {
      unallocatedMicro += charge;
      continue;
    }
    for (const { item, part } of splitByWeight(charge, members, (lot) => lot.quantity)) {
      shares.set(item.lotKey, (shares.get(item.lotKey) ?? 0n) + part);
    }
  }
  return { shares, unallocatedMicro };
}
