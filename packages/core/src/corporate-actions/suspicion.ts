// Suspicion heuristics (plan S10b task 3, ADR-0015): patterns that suggest a corporate action the user hasn't
// entered. Suggestions only, never applied automatically.
//   (a) a sell beyond the holding that is a whole multiple (>= 2) of it: a missed split or bonus
//   (b) a holding that goes quiet while a new instrument appears with a sell (no buy) of a related quantity
//       (one a whole multiple of the other): a missed conversion or demerger
import type { Reconstruction } from '../adjustments/apply.js';
import type { FillAllocation } from '../fifo/types.js';
import type { Position } from '../positions/build.js';

export type CorporateActionSuspicion =
  | {
      readonly kind: 'split_or_bonus';
      readonly accountId: string;
      readonly instrumentKey: string;
      readonly dateIst: string;
      readonly multiple: bigint;
    }
  | {
      readonly kind: 'conversion_or_demerger';
      readonly accountId: string;
      readonly fromInstrument: string;
      readonly toInstrument: string;
      readonly dateIst: string;
    };

function splitOrBonus(reconstruction: Reconstruction): CorporateActionSuspicion[] {
  const orphaned = new Map(
    reconstruction.positions.flatMap((position) =>
      position.orphans.map((orphan) => [orphan.allocation, orphan] as const),
    ),
  );
  return reconstruction.allocations.flatMap((sell) => {
    const orphan = orphaned.get(sell.key);
    if (orphan === undefined) return [];
    // A sell with an orphan sold more than was held, so a whole multiple of the holding is at least 2x.
    const held = sell.quantity - orphan.quantity;
    if (held === 0n || sell.quantity % held !== 0n) return [];
    return [
      {
        kind: 'split_or_bonus' as const,
        accountId: sell.accountId,
        instrumentKey: sell.instrumentKey,
        dateIst: orphan.dateIst,
        multiple: sell.quantity / held,
      },
    ];
  });
}

const related = (a: bigint, b: bigint): boolean => a % b === 0n || b % a === 0n;

function openQuantity(position: Position): bigint {
  return position.lots.reduce((sum, lot) => (lot.exit === null ? sum + lot.quantity : sum), 0n);
}

function lastActivity(allocations: readonly FillAllocation[], position: Position): string {
  return allocations
    .filter(
      (allocation) =>
        allocation.accountId === position.accountId && allocation.instrumentKey === position.instrumentKey,
    )
    .reduce(
      (latest, allocation) => (allocation.executedAtUtc > latest ? allocation.executedAtUtc : latest),
      position.openedAtUtc,
    );
}

function conversionOrDemerger(reconstruction: Reconstruction): CorporateActionSuspicion[] {
  const { allocations, positions } = reconstruction;
  const quiet = positions
    .filter((position) => position.state === 'OPEN' && position.bucket !== 'INTRADAY')
    .map((position) => ({
      position,
      quantity: openQuantity(position),
      last: lastActivity(allocations, position),
    }));
  const firstSeen = new Map<string, string>();
  for (const allocation of allocations) {
    const key = `${allocation.accountId}\u0000${allocation.instrumentKey}`;
    if (!firstSeen.has(key)) firstSeen.set(key, allocation.executedAtUtc);
  }
  return positions.flatMap((position) => {
    const [orphan] = position.orphans;
    // A new instrument: its first ever activity is the orphan sell.
    if (
      orphan === undefined ||
      firstSeen.get(`${orphan.accountId}\u0000${orphan.instrumentKey}`) !== orphan.atUtc
    )
      return [];
    return quiet
      .filter(
        (candidate) =>
          candidate.position.accountId === orphan.accountId &&
          candidate.position.instrumentKey !== orphan.instrumentKey &&
          candidate.last < orphan.atUtc &&
          related(candidate.quantity, orphan.quantity),
      )
      .map((candidate) => ({
        kind: 'conversion_or_demerger' as const,
        accountId: orphan.accountId,
        fromInstrument: candidate.position.instrumentKey,
        toInstrument: orphan.instrumentKey,
        dateIst: orphan.dateIst,
      }));
  });
}

export function suspectCorporateActions(reconstruction: Reconstruction): CorporateActionSuspicion[] {
  return [...splitOrBonus(reconstruction), ...conversionOrDemerger(reconstruction)];
}
