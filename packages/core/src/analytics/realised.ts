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
  for (const lot of [...lots].sort((a, b) =>
    a.exitDateIst < b.exitDateIst ? -1 : a.exitDateIst > b.exitDateIst ? 1 : 0,
  )) {
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

/**
 * Each allocation's charges spread over the lots it belongs to by quantity, with exact sums (largest remainder):
 * a lot's charge is its share of its entry fill's charges plus its share of its exit fill's.
 */
export function apportionLotCharges(
  allocationCharges: ReadonlyMap<string, bigint>,
  lots: readonly LotLink[],
): Map<string, bigint> {
  const byAllocation = new Map<string, LotLink[]>();
  for (const lot of lots) {
    for (const key of lot.exit === null ? [lot.entry] : [lot.entry, lot.exit]) {
      byAllocation.set(key, [...(byAllocation.get(key) ?? []), lot]);
    }
  }
  const shares = new Map(lots.map((lot) => [lot.lotKey, 0n]));
  for (const [key, members] of byAllocation) {
    const charge = allocationCharges.get(key) ?? 0n;
    for (const { item, part } of splitByWeight(charge, members, (lot) => lot.quantity)) {
      shares.set(item.lotKey, (shares.get(item.lotKey) ?? 0n) + part);
    }
  }
  return shares;
}
