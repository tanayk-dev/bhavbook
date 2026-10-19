// Applying corporate actions (plan S10b task 1). An action takes effect at the start of its ex-date (IST), on the
// quantity of each buy still open at that moment. Each such buy allocation splits into the part already sold
// (unchanged) and the open part, which the action transforms:
//   SPLIT       open qty x ratio; cost and entry date unchanged
//   CONVERSION  as SPLIT, moved to the new ISIN
//   DEMERGER    the parent keeps the open qty with (1 - split) of its cost; a child lot on the new ISIN gets
//               qty x ratio and the rest of the cost, with the parent's date
//   BONUS       an extra lot of holding x ratio at Rs 0, dated at allotment
// Entitlements are computed on each (account, bucket) holding, floored, and spread over the lots exactly; the
// fraction is reported. Intraday holdings never span an ex-date. Pure and deterministic.
import { InvalidArgumentError } from '../errors.js';
import { matchFifo } from '../fifo/match.js';
import { compareAllocations, groupBy, sortedEntries, type FillAllocation } from '../fifo/types.js';
import { allocateLargestRemainder, splitByWeight } from '../money/allocate.js';
import { istDayBounds } from '../time/ist.js';
import type { CorporateAction, Fraction } from './types.js';

const TYPES: ReadonlySet<string> = new Set(['SPLIT', 'BONUS', 'CONVERSION', 'DEMERGER']);
const BASIS_POINTS = 10_000n;

function dayStart(date: string): string {
  try {
    return istDayBounds(date).startUtc;
  } catch (error) {
    throw new InvalidArgumentError('a corporate action date must be a real YYYY-MM-DD date', {
      cause: error,
    });
  }
}

/** A validated action: `target` is where open lots end up (the new ISIN, or the same one), `split` the child bp. */
export interface CheckedCorporateAction {
  readonly action: CorporateAction;
  readonly start: string;
  readonly target: string;
  readonly split: bigint;
}

export function checkCorporateAction(action: CorporateAction): CheckedCorporateAction {
  // Stored data may not respect the types.
  const { type, ratioNum, ratioDen, costSplitBp }: Record<string, unknown> = { ...action };
  if (typeof type !== 'string' || !TYPES.has(type))
    throw new InvalidArgumentError('unknown corporate action type');
  if (typeof ratioNum !== 'bigint' || typeof ratioDen !== 'bigint' || ratioNum <= 0n || ratioDen <= 0n) {
    throw new InvalidArgumentError('a ratio must be a positive integer pair');
  }
  if (costSplitBp !== null && typeof costSplitBp !== 'bigint')
    throw new InvalidArgumentError('a cost split is an integer');
  const start = dayStart(action.exDateIst);
  if (action.allotmentDateIst !== null) dayStart(action.allotmentDateIst);
  const moves = action.type === 'CONVERSION' || action.type === 'DEMERGER';
  if (moves && action.newIsin === null)
    throw new InvalidArgumentError('a conversion or demerger needs the new ISIN');
  const split = action.costSplitBp ?? 0n;
  if (action.type === 'DEMERGER' && (action.costSplitBp === null || split < 0n || split > BASIS_POINTS)) {
    throw new InvalidArgumentError('a demerger needs a cost split between 0 and 10000 basis points');
  }
  return { action, start, target: action.newIsin ?? action.isin, split };
}

/** Splits a non-negative total into two parts by weight, exactly (largest remainder). */
function splitTwo(total: bigint, first: bigint, second: bigint): [bigint, bigint] {
  const [a = 0n, b = 0n] = allocateLargestRemainder(total, [first, second]);
  return [a, b];
}

export interface OpenAllocation {
  readonly allocation: FillAllocation;
  readonly open: bigint;
}

interface Part {
  /** The key of the allocation this part replaces. */
  readonly source: string;
  readonly allocation: FillAllocation;
  readonly quantity: bigint;
  readonly valueMicro: bigint;
}

/** Parts that got no shares hand their cost to the last part that did; with no shares at all, nothing remains. */
function settle(parts: readonly Part[]): Part[] {
  const kept = parts.filter((part) => part.quantity > 0n);
  const lost = parts.filter((part) => part.quantity === 0n).reduce((sum, part) => sum + part.valueMicro, 0n);
  return kept.map((part, index) =>
    index === kept.length - 1 ? { ...part, valueMicro: part.valueMicro + lost } : part,
  );
}

function childOf(allocation: FillAllocation, checked: CheckedCorporateAction): FillAllocation {
  const { action } = checked;
  return {
    ...allocation,
    key: `${allocation.key}~${action.id}~child`,
    fillId: `ca:${action.id}:${allocation.key}`,
    adjustmentId: null,
    corporateActionId: action.id,
    instrumentKey: checked.target,
    dedupKey: `${allocation.dedupKey}~${action.id}`,
  };
}

function bonusLot(checked: CheckedCorporateAction, like: FillAllocation, quantity: bigint): FillAllocation {
  const { action } = checked;
  const id = `ca:${action.id}:${like.accountId}:${like.bucket}`;
  return {
    key: id,
    fillId: id,
    adjustmentId: null,
    corporateActionId: action.id,
    accountId: like.accountId,
    instrumentKey: action.isin,
    bucket: like.bucket,
    side: 'BUY',
    quantity,
    valueMicro: 0n,
    inferred: false,
    executedAtUtc: checked.start,
    tradeDateIst: action.allotmentDateIst ?? action.exDateIst,
    dedupKey: `ca:${action.id}`,
  };
}

interface Applied {
  readonly replacements: Map<string, FillAllocation[]>;
  readonly added: FillAllocation[];
  readonly fractions: Fraction[];
}

/** The transformed open parts (and demerger children) of one holding. */
function transform(
  checked: CheckedCorporateAction,
  members: readonly OpenAllocation[],
  entitlement: bigint,
): Part[] {
  const { action } = checked;
  const parents: Part[] = [];
  const children: Part[] = [];
  for (const { item: member, part: shares } of splitByWeight(entitlement, members, (entry) => entry.open)) {
    const { allocation, open } = member;
    const openValue = openValueOf(member);
    const opened = { ...allocation, key: `${allocation.key}~${action.id}` };
    if (action.type === 'DEMERGER') {
      const [parentValue, childValue] = splitTwo(openValue, BASIS_POINTS - checked.split, checked.split);
      parents.push({ source: allocation.key, allocation: opened, quantity: open, valueMicro: parentValue });
      children.push({
        source: allocation.key,
        allocation: childOf(allocation, checked),
        quantity: shares,
        valueMicro: childValue,
      });
    } else {
      const moved = { ...opened, instrumentKey: checked.target };
      parents.push({ source: allocation.key, allocation: moved, quantity: shares, valueMicro: openValue });
    }
  }
  return [...settle(parents), ...settle(children)];
}

/** The cost of the part of a buy allocation still open. */
export function openValueOf({ allocation, open }: OpenAllocation): bigint {
  return splitTwo(allocation.valueMicro, allocation.quantity - open, open)[1];
}

/** One (account, bucket) holding of the action's ISIN at the ex-date. */
function applyToHolding(
  checked: CheckedCorporateAction,
  members: readonly OpenAllocation[],
  applied: Applied,
): void {
  const { action } = checked;
  const [head] = members as [OpenAllocation, ...OpenAllocation[]];
  const holding = members.reduce((sum, member) => sum + member.open, 0n);
  const entitlement = (holding * action.ratioNum) / action.ratioDen;
  const remainder = (holding * action.ratioNum) % action.ratioDen;
  if (remainder > 0n) {
    applied.fractions.push({
      actionId: action.id,
      accountId: head.allocation.accountId,
      instrumentKey: action.isin,
      bucket: head.allocation.bucket,
      numerator: remainder,
      denominator: action.ratioDen,
    });
  }
  if (action.type === 'BONUS') {
    if (entitlement > 0n) applied.added.push(bonusLot(checked, head.allocation, entitlement));
    return;
  }
  const parts = transform(checked, members, entitlement);
  for (const { allocation, open } of members) {
    const consumed = allocation.quantity - open;
    const [soldValue] = splitTwo(allocation.valueMicro, consumed, open);
    const sold = consumed > 0n ? [{ ...allocation, quantity: consumed, valueMicro: soldValue }] : [];
    const transformed = parts
      .filter((part) => part.source === allocation.key)
      .map((part) => ({ ...part.allocation, quantity: part.quantity, valueMicro: part.valueMicro }));
    applied.replacements.set(allocation.key, [...sold, ...transformed]);
  }
}

/** The open quantity of every affected buy allocation just before the ex-date. */
export function openAt(
  allocations: readonly FillAllocation[],
  checked: CheckedCorporateAction,
): OpenAllocation[] {
  const before = allocations.filter(
    (allocation) =>
      allocation.instrumentKey === checked.action.isin &&
      allocation.bucket !== 'INTRADAY' &&
      allocation.executedAtUtc < checked.start,
  );
  const open = new Map<string, bigint>();
  for (const lot of matchFifo(before).lots) {
    if (lot.exit === null) open.set(lot.entry, (open.get(lot.entry) ?? 0n) + lot.quantity);
  }
  return before.flatMap((allocation) => {
    const quantity = open.get(allocation.key);
    return quantity === undefined ? [] : [{ allocation, open: quantity }];
  });
}

export interface CorporateActionResult {
  readonly allocations: FillAllocation[];
  readonly fractions: Fraction[];
}

export function applyCorporateAction(
  allocations: readonly FillAllocation[],
  checked: CheckedCorporateAction,
): CorporateActionResult {
  const applied: Applied = { replacements: new Map(), added: [], fractions: [] };
  const holdings = groupBy(openAt(allocations, checked), ({ allocation }) =>
    [allocation.accountId, allocation.bucket].join('\u0000'),
  );
  for (const [, members] of sortedEntries(holdings)) applyToHolding(checked, members, applied);
  const next = allocations.flatMap((allocation) => applied.replacements.get(allocation.key) ?? [allocation]);
  return { allocations: [...next, ...applied.added].sort(compareAllocations), fractions: applied.fractions };
}

/** Actions apply in ex-date order, then id. */
export function orderKey(action: CorporateAction): string {
  return `${action.exDateIst}\u0000${action.id}`;
}

/** Validates every action and orders them by ex-date, then id. */
export function orderCorporateActions(actions: readonly CorporateAction[]): CheckedCorporateAction[] {
  const ids = new Set<string>();
  const checked = actions.map((action) => {
    if (ids.has(action.id)) throw new InvalidArgumentError('two corporate actions with the same id');
    ids.add(action.id);
    return checkCorporateAction(action);
  });
  return checked.sort((a, b) => (orderKey(a.action) < orderKey(b.action) ? -1 : 1));
}

/** Applies every action, in ex-date order (then id), each on the result of the ones before. */
export function applyCorporateActions(
  allocations: readonly FillAllocation[],
  actions: readonly CorporateAction[],
): CorporateActionResult {
  let current = [...allocations];
  const fractions: Fraction[] = [];
  for (const checked of orderCorporateActions(actions)) {
    const result = applyCorporateAction(current, checked);
    current = result.allocations;
    fractions.push(...result.fractions);
  }
  return { allocations: current, fractions };
}
