// Applying corporate actions (plan S10b task 1). An action takes effect at the start of its ex-date (IST), on the
// quantity of each buy still open at that moment. Each such buy allocation splits into the part already sold
// (unchanged) and the open part, which the action reshapes (key `<key>~<action id>`):
//   SPLIT       open qty x ratio; cost and entry date unchanged
//   CONVERSION  as SPLIT, moved to the new ISIN
//   DEMERGER    the parent keeps the open qty with (1 - split) of its cost; a child lot on the new ISIN gets
//               qty x ratio and the rest of the cost, with the parent's date and anchor (exclusions follow it)
//   BONUS       an extra lot of holding x ratio at Rs 0, dated at allotment
// Entitlements are computed on each (account, bucket) holding, floored, and spread over the lots exactly; the
// fraction is reported. Cost is conserved: a lot that gets no shares hands its cost to one that does; only a
// holding left with no shares at all (cash in lieu) loses its cost, and the fraction reports it. A demerger child
// too small for a share hands its cost back to the parent. Intraday holdings never span an ex-date.
// Pure and deterministic. Corporate actions are stored data, so every field is checked here.
import { InvalidArgumentError } from '../errors.js';
import { matchFifo } from '../fifo/match.js';
import { byText, compareAllocations, groupBy, sortedEntries, type FillAllocation } from '../fifo/types.js';
import { allocateLargestRemainder, splitByWeight } from '../money/allocate.js';
import { istDayBounds } from '../time/ist.js';
import type { CorporateAction, Fraction } from './types.js';

const TYPES: ReadonlySet<string> = new Set(['SPLIT', 'BONUS', 'CONVERSION', 'DEMERGER']);
const MOVING: ReadonlySet<string> = new Set(['CONVERSION', 'DEMERGER']);
const BASIS_POINTS = 10_000n;
/** Ids become part of allocation keys (`~` and `:` separate key parts), so they are kept to a safe alphabet. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function dayStart(date: unknown): string {
  if (typeof date !== 'string') throw new InvalidArgumentError('a corporate action date must be a string');
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

function checkFields(raw: Readonly<Record<string, unknown>>): void {
  const { id, type, isin, newIsin, ratioNum, ratioDen, costSplitBp, allotmentDateIst } = raw;
  if (typeof type !== 'string' || !TYPES.has(type))
    throw new InvalidArgumentError('unknown corporate action type');
  if (typeof id !== 'string' || !ID_PATTERN.test(id))
    throw new InvalidArgumentError('a corporate action id is 1-64 letters, digits, _ or -');
  if (typeof isin !== 'string' || isin === '')
    throw new InvalidArgumentError('a corporate action needs its ISIN');
  if (typeof ratioNum !== 'bigint' || typeof ratioDen !== 'bigint' || ratioNum <= 0n || ratioDen <= 0n) {
    throw new InvalidArgumentError('a ratio must be a positive integer pair');
  }
  const moving = MOVING.has(type);
  if (moving !== (typeof newIsin === 'string' && newIsin !== '' && newIsin !== isin)) {
    throw new InvalidArgumentError('a conversion or demerger (only) needs a new, different ISIN');
  }
  if (moving !== (newIsin !== null))
    throw new InvalidArgumentError('only a conversion or demerger has a new ISIN');
  const demerger = type === 'DEMERGER';
  const validSplit = typeof costSplitBp === 'bigint' && costSplitBp >= 0n && costSplitBp <= BASIS_POINTS;
  if (demerger ? !validSplit : costSplitBp !== null) {
    throw new InvalidArgumentError('a demerger (only) needs a cost split between 0 and 10000 basis points');
  }
  if (allotmentDateIst !== null) {
    if (type !== 'BONUS') throw new InvalidArgumentError('only a bonus has an allotment date');
    dayStart(allotmentDateIst);
  }
}

export function checkCorporateAction(action: CorporateAction): CheckedCorporateAction {
  // Stored data may not respect the types.
  const raw: Readonly<Record<string, unknown>> = { ...action };
  checkFields(raw);
  const start = dayStart(raw.exDateIst);
  return { action, start, target: action.newIsin ?? action.isin, split: action.costSplitBp ?? 0n };
}

/** Splits a non-negative total into two parts by weight, exactly (largest remainder). */
function splitTwo(total: bigint, first: bigint, second: bigint): readonly [bigint, bigint] {
  const [a, b] = allocateLargestRemainder(total, [first, second]) as readonly [bigint, bigint];
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

const totalValue = (parts: readonly Part[]): bigint => parts.reduce((sum, part) => sum + part.valueMicro, 0n);

/** Parts that got no shares hand their cost to the last part that did; with no shares at all, nothing remains. */
function settle(parts: readonly Part[]): Part[] {
  const kept = parts.filter((part) => part.quantity > 0n);
  const lost = totalValue(parts.filter((part) => part.quantity === 0n));
  return kept.map((part, index) =>
    index === kept.length - 1 ? { ...part, valueMicro: part.valueMicro + lost } : part,
  );
}

/** The cost of the part of a buy allocation still open. */
export function openValueOf({ allocation, open }: OpenAllocation): bigint {
  return splitTwo(allocation.valueMicro, allocation.quantity - open, open)[1];
}

function reshaped(
  allocation: FillAllocation,
  checked: CheckedCorporateAction,
  instrumentKey: string,
): FillAllocation {
  return {
    ...allocation,
    key: `${allocation.key}~${checked.action.id}`,
    corporateActionId: checked.action.id,
    instrumentKey,
  };
}

function childOf(allocation: FillAllocation, checked: CheckedCorporateAction): FillAllocation {
  // The child keeps the parent's dedup key, so its anchor (and any exclusion of it) follows the parent.
  return {
    ...reshaped(allocation, checked, checked.target),
    key: `${allocation.key}~${checked.action.id}~child`,
    fillId: `ca:${checked.action.id}:${allocation.key}`,
    adjustmentId: null,
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

interface Transformed {
  readonly parts: readonly Part[];
  readonly removedMicro: bigint;
}

/** The reshaped open parts (and demerger children) of one holding, and any cost that left with no shares. */
function transform(
  checked: CheckedCorporateAction,
  members: readonly OpenAllocation[],
  entitlement: bigint,
): Transformed {
  const parents: Part[] = [];
  const children: Part[] = [];
  for (const { item: member, part: shares } of splitByWeight(entitlement, members, (entry) => entry.open)) {
    const { allocation, open } = member;
    const value = openValueOf(member);
    if (checked.action.type === 'DEMERGER') {
      const [parentValue, childValue] = splitTwo(value, BASIS_POINTS - checked.split, checked.split);
      const parent = reshaped(allocation, checked, allocation.instrumentKey);
      parents.push({ source: allocation.key, allocation: parent, quantity: open, valueMicro: parentValue });
      children.push({
        source: allocation.key,
        allocation: childOf(allocation, checked),
        quantity: shares,
        valueMicro: childValue,
      });
    } else {
      const moved = reshaped(allocation, checked, checked.target);
      parents.push({ source: allocation.key, allocation: moved, quantity: shares, valueMicro: value });
    }
  }
  if (checked.action.type !== 'DEMERGER') {
    const kept = settle(parents);
    return { parts: kept, removedMicro: kept.length === 0 ? totalValue(parents) : 0n };
  }
  const keptChildren = settle(children);
  if (keptChildren.length > 0) return { parts: [...parents, ...keptChildren], removedMicro: 0n };
  // Parents always keep their shares: the child's cost goes back to the last of them.
  const giveBack = totalValue(children);
  const last = parents.length - 1;
  return {
    parts: parents.map((part, index) =>
      index === last ? { ...part, valueMicro: part.valueMicro + giveBack } : part,
    ),
    removedMicro: 0n,
  };
}

interface Applied {
  readonly replacements: Map<string, FillAllocation[]>;
  readonly created: FillAllocation[];
  readonly bonuses: FillAllocation[];
  readonly fractions: Fraction[];
}

/** One (account, bucket) holding of the action's ISIN at the ex-date (groups are never empty). */
function applyToHolding(
  checked: CheckedCorporateAction,
  members: readonly OpenAllocation[],
  applied: Applied,
): void {
  const { action } = checked;
  const [{ allocation: head }] = members as readonly [OpenAllocation, ...OpenAllocation[]];
  const holding = members.reduce((sum, member) => sum + member.open, 0n);
  const entitlement = (holding * action.ratioNum) / action.ratioDen;
  const remainder = (holding * action.ratioNum) % action.ratioDen;
  const { parts, removedMicro } =
    action.type === 'BONUS' ? { parts: [], removedMicro: 0n } : transform(checked, members, entitlement);
  if (remainder > 0n) {
    applied.fractions.push({
      actionId: action.id,
      accountId: head.accountId,
      instrumentKey: checked.target,
      bucket: head.bucket,
      numerator: remainder,
      denominator: action.ratioDen,
      costRemovedMicro: removedMicro,
    });
  }
  if (action.type === 'BONUS') {
    if (entitlement > 0n) applied.bonuses.push(bonusLot(checked, head, entitlement));
    return;
  }
  for (const { allocation, open } of members) {
    const consumed = allocation.quantity - open;
    const [soldValue] = splitTwo(allocation.valueMicro, consumed, open);
    const sold = consumed > 0n ? [{ ...allocation, quantity: consumed, valueMicro: soldValue }] : [];
    const mine = parts
      .filter((part) => part.source === allocation.key)
      .map((part) => ({ ...part.allocation, quantity: part.quantity, valueMicro: part.valueMicro }));
    applied.replacements.set(allocation.key, [...sold, ...mine]);
    applied.created.push(...mine);
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
  /** The allocations this action created or reshaped (for a preview). */
  readonly created: FillAllocation[];
  readonly fractions: Fraction[];
}

export function applyCorporateAction(
  allocations: readonly FillAllocation[],
  checked: CheckedCorporateAction,
): CorporateActionResult {
  const applied: Applied = { replacements: new Map(), created: [], bonuses: [], fractions: [] };
  const holdings = groupBy(openAt(allocations, checked), ({ allocation }) =>
    [allocation.accountId, allocation.bucket].join('\u0000'),
  );
  for (const [, members] of sortedEntries(holdings)) applyToHolding(checked, members, applied);
  const next = allocations.flatMap((allocation) => applied.replacements.get(allocation.key) ?? [allocation]);
  return {
    allocations: [...next, ...applied.bonuses].sort(compareAllocations),
    created: [...applied.created, ...applied.bonuses],
    fractions: applied.fractions,
  };
}

/** Actions apply in ex-date order, then id. */
export function compareCorporateActions(a: CheckedCorporateAction, b: CheckedCorporateAction): number {
  return byText(a.start, b.start) || byText(a.action.id, b.action.id);
}

/** Validates every action and orders them by ex-date, then id. */
export function orderCorporateActions(actions: readonly CorporateAction[]): CheckedCorporateAction[] {
  const ids = new Set<string>();
  const checked = actions.map((action) => {
    const valid = checkCorporateAction(action);
    if (ids.has(action.id)) throw new InvalidArgumentError('two corporate actions with the same id');
    ids.add(action.id);
    return valid;
  });
  return checked.sort(compareCorporateActions);
}

/** Applies every action, in ex-date order (then id), each on the result of the ones before. */
export function applyCorporateActions(
  allocations: readonly FillAllocation[],
  actions: readonly CorporateAction[],
): { readonly allocations: FillAllocation[]; readonly fractions: Fraction[] } {
  let current = [...allocations];
  const fractions: Fraction[] = [];
  for (const checked of orderCorporateActions(actions)) {
    const result = applyCorporateAction(current, checked);
    current = result.allocations;
    fractions.push(...result.fractions);
  }
  return { allocations: current, fractions };
}
