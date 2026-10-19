// Instrument resolution (ADR-0014), pure. Dhan trade files carry neither ISIN nor the statement's scrip name, so a
// trade-file name is matched to a statement name by a **transaction join**: on every day the name traded that a
// statement covers, the statement name must show the same buy and sell quantities. Candidates are intersected
// across days; a remaining tie is broken by the closest traded values, then by an identical normalised name.
// The statement name's ISIN comes from the statements' own name -> ISIN hints. No security master is bundled.
import { normaliseName } from './suggest.js';

export interface DayAggregate {
  readonly date: string;
  readonly name: string;
  readonly buyQty: bigint;
  readonly sellQty: bigint;
  readonly buyValueMicro: bigint;
  readonly sellValueMicro: bigint;
}

export interface Fill {
  readonly date: string;
  readonly name: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: bigint;
  readonly valueMicro: bigint;
}

export interface IsinHint {
  readonly name: string;
  readonly isin: string;
}

export interface KnownAlias {
  readonly alias: string;
  readonly isin: string;
}

export interface ResolvedAlias {
  readonly alias: string;
  readonly isin: string;
  readonly source: 'join' | 'learned';
  /** The statement name the join went through; null for a learned alias. */
  readonly via: string | null;
}

export type UnresolvedReason =
  'no_evidence' | 'no_match' | 'value_mismatch' | 'ambiguous' | 'no_isin' | 'conflicting_isin' | 'conflict';

export interface UnresolvedAlias {
  readonly alias: string;
  readonly reason: UnresolvedReason;
  /** Statement names still in play (sorted). */
  readonly candidates: readonly string[];
}

export interface ResolveInput {
  readonly trades: readonly DayAggregate[];
  readonly statements: readonly DayAggregate[];
  readonly hints: readonly IsinHint[];
  readonly known: readonly KnownAlias[];
}

export interface ResolveResult {
  readonly resolved: readonly ResolvedAlias[];
  readonly unresolved: readonly UnresolvedAlias[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/** Merges aggregates of the same (date, name), e.g. one statement row per bill. Sorted by date, then name. */
export function mergeDayAggregates(rows: readonly DayAggregate[]): DayAggregate[] {
  const merged = new Map<string, DayAggregate>();
  for (const row of rows) {
    const key = `${row.date}\u0000${row.name}`;
    const seen = merged.get(key);
    merged.set(
      key,
      seen === undefined
        ? row
        : {
            ...seen,
            buyQty: seen.buyQty + row.buyQty,
            sellQty: seen.sellQty + row.sellQty,
            buyValueMicro: seen.buyValueMicro + row.buyValueMicro,
            sellValueMicro: seen.sellValueMicro + row.sellValueMicro,
          },
    );
  }
  return [...merged.values()].sort((a, b) => byText(a.date, b.date) || byText(a.name, b.name));
}

/** Per (date, name): total bought and sold quantity and value. */
export function aggregateByDay(fills: readonly Fill[]): DayAggregate[] {
  return mergeDayAggregates(
    fills.map((fill) => ({
      date: fill.date,
      name: fill.name,
      buyQty: fill.side === 'BUY' ? fill.quantity : 0n,
      sellQty: fill.side === 'SELL' ? fill.quantity : 0n,
      buyValueMicro: fill.side === 'BUY' ? fill.valueMicro : 0n,
      sellValueMicro: fill.side === 'SELL' ? fill.valueMicro : 0n,
    })),
  );
}

interface Evidence {
  readonly days: readonly { trade: DayAggregate; statements: readonly DayAggregate[] }[];
}

/** `next` when nothing was seen yet, else the names in both. */
function intersect(seen: ReadonlySet<string> | null, next: ReadonlySet<string>): Set<string> {
  return new Set(seen === null ? next : [...seen].filter((name) => next.has(name)));
}

/** The statement names consistent with every evidence day (null when no day has statements). */
function candidatesOf(evidence: Evidence): Set<string> | null {
  let candidates: Set<string> | null = null;
  for (const { trade, statements } of evidence.days) {
    const matching = new Set(
      statements
        .filter((row) => row.buyQty === trade.buyQty && row.sellQty === trade.sellQty)
        .map((row) => row.name),
    );
    candidates = intersect(candidates, matching);
  }
  return candidates;
}

/**
 * Trade and statement values for the same scrip and day agree to within rounding (on real files: at most Rs 0.06;
 * wrong candidates were 80-450% off). Per day and side: Rs 1 plus 0.01% of the value.
 */
const VALUE_SLACK_MICRO = 1_000_000n;
const VALUE_SLACK_DIVISOR = 10_000n;

function valuesAgree(trade: bigint, statement: bigint): boolean {
  return abs(trade - statement) <= VALUE_SLACK_MICRO + trade / VALUE_SLACK_DIVISOR;
}

/** Candidates whose values agree with the trades on every evidence day. */
function agreeingOnValue(evidence: Evidence, candidates: readonly string[]): string[] {
  return candidates.filter((name) =>
    evidence.days.every(({ trade, statements }) => {
      const row = statements.find((entry) => entry.name === name);
      return (
        row !== undefined &&
        valuesAgree(trade.buyValueMicro, row.buyValueMicro) &&
        valuesAgree(trade.sellValueMicro, row.sellValueMicro)
      );
    }),
  );
}

function sameName(alias: string, candidates: readonly string[]): string | null {
  const target = normaliseName(alias).join(' ');
  if (target === '') return null;
  const hits = candidates.filter((name) => normaliseName(name).join(' ') === target);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

type JoinOutcome =
  | { readonly statementName: string }
  | { readonly reason: UnresolvedReason; readonly candidates: readonly string[] };

/**
 * Quantities match on every evidence day, values agree, and exactly one statement name remains (an identical
 * normalised name settles a tie among value-agreeing candidates). Anything else stays unresolved: a wrong
 * mapping is worse than none.
 */
function join(alias: string, evidence: Evidence): JoinOutcome {
  const found = candidatesOf(evidence);
  if (found === null) return { reason: 'no_evidence', candidates: [] };
  const candidates = [...found].sort(byText);
  if (candidates.length === 0) return { reason: 'no_match', candidates };
  const agreeing = agreeingOnValue(evidence, candidates);
  if (agreeing.length === 0) return { reason: 'value_mismatch', candidates };
  const [only, ...others] = agreeing;
  if (only !== undefined && others.length === 0) return { statementName: only };
  const pick = sameName(alias, agreeing);
  return pick === null ? { reason: 'ambiguous', candidates: agreeing } : { statementName: pick };
}

/** name -> ISIN, plus the names seen with more than one ISIN (never used to resolve). */
function hintIndex(hints: readonly IsinHint[]): {
  isinByName: Map<string, string>;
  conflicting: Set<string>;
} {
  const isins = new Map<string, Set<string>>();
  for (const { name, isin } of hints) {
    const set = isins.get(name) ?? new Set<string>();
    set.add(isin);
    isins.set(name, set);
  }
  const isinByName = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const [name, set] of isins) {
    const [only, ...rest] = [...set];
    if (only !== undefined && rest.length === 0) isinByName.set(name, only);
    else conflicting.add(name);
  }
  return { isinByName, conflicting };
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

export function resolveAliases(input: ResolveInput): ResolveResult {
  const statementsByDate = groupBy(mergeDayAggregates(input.statements), (row) => row.date);
  const { isinByName, conflicting } = hintIndex(input.hints);
  const learned = new Map(input.known.map((entry) => [entry.alias, entry.isin]));
  const tradesByName = groupBy(mergeDayAggregates(input.trades), (row) => row.name);

  const resolved: ResolvedAlias[] = [];
  const unresolved: UnresolvedAlias[] = [];
  for (const alias of [...tradesByName.keys()].sort(byText)) {
    const days = (tradesByName.get(alias) ?? []).flatMap((trade) => {
      const statements = statementsByDate.get(trade.date);
      return statements === undefined ? [] : [{ trade, statements }];
    });
    const outcome = join(alias, { days });
    if ('statementName' in outcome) {
      const isin = isinByName.get(outcome.statementName);
      if (isin !== undefined) {
        resolved.push({ alias, isin, source: 'join', via: outcome.statementName });
        continue;
      }
    }
    const known = learned.get(alias);
    if (known !== undefined) {
      resolved.push({ alias, isin: known, source: 'learned', via: null });
      continue;
    }
    if ('statementName' in outcome) {
      const reason = conflicting.has(outcome.statementName) ? 'conflicting_isin' : 'no_isin';
      unresolved.push({ alias, reason, candidates: [outcome.statementName] });
    } else {
      unresolved.push({ alias, reason: outcome.reason, candidates: [...outcome.candidates] });
    }
  }
  return { resolved, unresolved };
}

export interface SymbolIsins {
  readonly bySymbol: readonly { symbol: string; isin: string }[];
  /** Symbols seen with two different ISINs: never filled. */
  readonly conflicts: readonly string[];
  /** Symbols seen only without an ISIN. */
  readonly missing: readonly string[];
}

/** Zerodha: a blank ISIN is filled from the same symbol elsewhere in the file or vault, when that is unique. */
export function fillIsinsBySymbol(rows: readonly { symbol: string; isin: string | null }[]): SymbolIsins {
  const isins = new Map<string, Set<string>>();
  for (const { symbol, isin } of rows) {
    const set = isins.get(symbol) ?? new Set<string>();
    if (isin !== null) set.add(isin);
    isins.set(symbol, set);
  }
  const symbols = [...isins.keys()].sort(byText);
  return {
    bySymbol: symbols.flatMap((symbol) => {
      const [only, ...rest] = [...(isins.get(symbol) ?? [])];
      return only !== undefined && rest.length === 0 ? [{ symbol, isin: only }] : [];
    }),
    conflicts: symbols.filter((symbol) => (isins.get(symbol)?.size ?? 0) > 1),
    missing: symbols.filter((symbol) => (isins.get(symbol)?.size ?? 0) === 0),
  };
}
