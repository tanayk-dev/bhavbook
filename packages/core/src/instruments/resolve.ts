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

export type UnresolvedReason = 'no_evidence' | 'no_match' | 'ambiguous' | 'no_isin';

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

/** The statement names consistent with every evidence day (null when no day has statements). */
function candidatesOf(evidence: Evidence): Set<string> | null {
  let candidates: Set<string> | null = null;
  for (const { trade, statements } of evidence.days) {
    const matching = new Set(
      statements
        .filter((row) => row.buyQty === trade.buyQty && row.sellQty === trade.sellQty)
        .map((row) => row.name),
    );
    candidates = candidates === null ? matching : new Set([...candidates].filter((name) => matching.has(name)));
  }
  return candidates;
}

/** The unique candidate with the smallest total value difference, or null on a tie. */
function closestByValue(evidence: Evidence, candidates: readonly string[]): string | null {
  const distance = (name: string): bigint =>
    evidence.days.reduce((sum, { trade, statements }) => {
      const row = statements.find((entry) => entry.name === name);
      if (row === undefined) return sum;
      return sum + abs(trade.buyValueMicro - row.buyValueMicro) + abs(trade.sellValueMicro - row.sellValueMicro);
    }, 0n);
  const ranked = candidates.map((name) => ({ name, distance: distance(name) }));
  const best = ranked.reduce((min, entry) => (entry.distance < min ? entry.distance : min), ranked[0]?.distance ?? 0n);
  const winners = ranked.filter((entry) => entry.distance === best);
  return winners.length === 1 ? (winners[0]?.name ?? null) : null;
}

function sameName(alias: string, candidates: readonly string[]): string | null {
  const target = normaliseName(alias).join(' ');
  const hits = candidates.filter((name) => normaliseName(name).join(' ') === target);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

type JoinOutcome = { readonly statementName: string } | { readonly reason: UnresolvedReason; candidates: string[] };

function join(evidence: Evidence): JoinOutcome {
  const found = candidatesOf(evidence);
  if (found === null) return { reason: 'no_evidence', candidates: [] };
  const candidates = [...found].sort(byText);
  if (candidates.length === 0) return { reason: 'no_match', candidates };
  if (candidates.length === 1) return { statementName: candidates[0] ?? '' };
  const pick = closestByValue(evidence, candidates) ?? sameNameFromEvidence(evidence, candidates);
  return pick === null ? { reason: 'ambiguous', candidates } : { statementName: pick };
}

function sameNameFromEvidence(evidence: Evidence, candidates: readonly string[]): string | null {
  const alias = evidence.days[0]?.trade.name;
  return alias === undefined ? null : sameName(alias, candidates);
}

export function resolveAliases(input: ResolveInput): ResolveResult {
  const statementsByDate = new Map<string, DayAggregate[]>();
  for (const row of mergeDayAggregates(input.statements)) {
    statementsByDate.set(row.date, [...(statementsByDate.get(row.date) ?? []), row]);
  }
  const isinByName = new Map(input.hints.map((hint) => [hint.name, hint.isin]));
  const learned = new Map(input.known.map((entry) => [entry.alias, entry.isin]));
  const tradesByName = new Map<string, DayAggregate[]>();
  for (const trade of mergeDayAggregates(input.trades)) {
    tradesByName.set(trade.name, [...(tradesByName.get(trade.name) ?? []), trade]);
  }

  const resolved: ResolvedAlias[] = [];
  const unresolved: UnresolvedAlias[] = [];
  for (const alias of [...tradesByName.keys()].sort(byText)) {
    const days = (tradesByName.get(alias) ?? []).flatMap((trade) => {
      const statements = statementsByDate.get(trade.date);
      return statements === undefined ? [] : [{ trade, statements }];
    });
    const outcome = join({ days });
    const isin = 'statementName' in outcome ? isinByName.get(outcome.statementName) : undefined;
    if ('statementName' in outcome && isin !== undefined) {
      resolved.push({ alias, isin, source: 'join', via: outcome.statementName });
      continue;
    }
    const known = learned.get(alias);
    if (known !== undefined) {
      resolved.push({ alias, isin: known, source: 'learned', via: null });
      continue;
    }
    unresolved.push(
      'statementName' in outcome
        ? { alias, reason: 'no_isin', candidates: [outcome.statementName] }
        : { alias, reason: outcome.reason, candidates: outcome.candidates },
    );
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
