// Positions (PRD §5.2): one run of (account, instrument, bucket) from 0 -> n -> 0. Scale-ins and scale-outs stay
// inside one run. A sell beyond the holding leaves orphan quantity and marks the run INCOMPLETE; consecutive sells
// while nothing is held form one INCOMPLETE run of their own. Intraday runs follow the signed day position
// (a short starts a run too) and never carry over a day.
import {
  compareAllocations,
  groupBy,
  sortedEntries,
  type Bucket,
  type FillAllocation,
  type Lot,
  type MatchResult,
  type Orphan,
} from '../fifo/types.js';

export interface Position {
  /** Deterministic: account, instrument, bucket and anchor (PRD §10: a recompute is byte-identical). */
  readonly id: string;
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: Bucket;
  readonly state: 'OPEN' | 'CLOSED';
  readonly incomplete: boolean;
  readonly orphanQty: bigint;
  readonly openedAtUtc: string;
  readonly closedAtUtc: string | null;
  /** `<dedup key of the opening fill>#<bucket>`: stable across recomputes and re-imports (journal anchor). */
  readonly anchorKey: string;
  readonly hasInferredProduct: boolean;
  readonly lots: readonly Lot[];
  readonly orphans: readonly Orphan[];
}

interface Run {
  readonly opening: FillAllocation;
  readonly members: FillAllocation[];
  orphanQty: bigint;
  closedAtUtc: string | null;
  /** Shares held (signed for intraday). */
  net: bigint;
}

function startRun(opening: FillAllocation): Run {
  return { opening, members: [], orphanQty: 0n, closedAtUtc: null, net: 0n };
}

/** DELIVERY / MTF: holdings never go below zero; unmatched sell quantity is orphaned. */
function heldRuns(allocations: readonly FillAllocation[], orphaned: ReadonlyMap<string, bigint>): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  let orphanRun = false;
  for (const allocation of allocations) {
    const orphanQty = orphaned.get(allocation.key) ?? 0n;
    if (allocation.side === 'BUY') {
      if (current === null || orphanRun) {
        current = startRun(allocation);
        orphanRun = false;
        runs.push(current);
      }
      current.members.push(allocation);
      current.net += allocation.quantity;
      continue;
    }
    if (current === null) {
      current = startRun(allocation);
      orphanRun = true;
      runs.push(current);
    }
    current.members.push(allocation);
    current.net -= allocation.quantity - orphanQty;
    current.orphanQty += orphanQty;
    if (current.net === 0n) current.closedAtUtc = allocation.executedAtUtc;
    if (current.net === 0n && !orphanRun) current = null;
  }
  return runs;
}

/** INTRADAY: runs of the signed position within one day. */
function intradayRuns(allocations: readonly FillAllocation[], orphaned: ReadonlyMap<string, bigint>): Run[] {
  return sortedEntries(groupBy(allocations, (allocation) => allocation.tradeDateIst)).flatMap(([, day]) => {
    const runs: Run[] = [];
    let current: Run | null = null;
    for (const allocation of day) {
      if (current === null) {
        current = startRun(allocation);
        runs.push(current);
      }
      const orphanQty = orphaned.get(allocation.key) ?? 0n;
      current.members.push(allocation);
      current.orphanQty += orphanQty;
      current.net += allocation.side === 'BUY' ? allocation.quantity : -(allocation.quantity - orphanQty);
      if (current.net === 0n) {
        current.closedAtUtc = allocation.executedAtUtc;
        current = null;
      }
    }
    return runs;
  });
}

function toPosition(run: Run, lots: readonly Lot[], orphans: readonly Orphan[]): Position {
  const { opening } = run;
  const anchorKey = `${opening.dedupKey}#${opening.bucket}`;
  const members = new Set(run.members.map((member) => member.key));
  const ownLots = lots.filter((lot) => members.has(lot.entry));
  return {
    id: [opening.accountId, opening.instrumentKey, opening.bucket, anchorKey].join('|'),
    accountId: opening.accountId,
    instrumentKey: opening.instrumentKey,
    bucket: opening.bucket,
    state: ownLots.some((lot) => lot.exit === null) ? 'OPEN' : 'CLOSED',
    incomplete: run.orphanQty > 0n,
    orphanQty: run.orphanQty,
    openedAtUtc: opening.executedAtUtc,
    closedAtUtc: ownLots.some((lot) => lot.exit === null) ? null : run.closedAtUtc,
    anchorKey,
    hasInferredProduct: run.members.some((member) => member.inferred),
    lots: ownLots,
    orphans: orphans.filter((orphan) => members.has(orphan.allocation)),
  };
}

export function buildPositions(allocations: readonly FillAllocation[], matched: MatchResult): Position[] {
  const orphaned = new Map<string, bigint>();
  for (const orphan of matched.orphans) {
    orphaned.set(orphan.allocation, (orphaned.get(orphan.allocation) ?? 0n) + orphan.quantity);
  }
  const groups = groupBy(allocations, (allocation) =>
    [allocation.accountId, allocation.instrumentKey, allocation.bucket].join('\u0000'),
  );
  return sortedEntries(groups).flatMap(([, group]) => {
    const ordered = [...group].sort(compareAllocations);
    const runs =
      ordered[0]?.bucket === 'INTRADAY' ? intradayRuns(ordered, orphaned) : heldRuns(ordered, orphaned);
    return runs.map((run) => toPosition(run, matched.lots, matched.orphans));
  });
}

/** Realised gross P&L of a position's closed lots (sell value - buy value), in micro-rupees. */
export function grossPnlMicro(position: Position): bigint {
  return position.lots.reduce(
    (sum, lot) => (lot.exitValueMicro === null ? sum : sum + lot.exitValueMicro - lot.entryValueMicro),
    0n,
  );
}
