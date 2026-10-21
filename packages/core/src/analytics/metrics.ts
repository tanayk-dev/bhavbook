// Trade analytics (S15a, PRD §9, ADR-0025). A trade is a CLOSED, non-excluded, complete position; incomplete ones
// count only with the toggle. Net = gross − all charges (reported where reconciled, else estimated: the caller
// passes the effective charges). Win / loss is by net; |net| ≤ the breakeven threshold is breakeven, a trade that is
// left out of the win rate. R = net ÷ planned risk: the user's amount, else Σ over the opening fills of
// |fill price − initial stop| × qty, so moving the stop later never changes R. Average R rounds each trade's R to
// six decimals first (R_SCALE), a declared rounding like ADR-0016's: exact fractions over thousands of distinct
// risks would grow without bound.
import type { Bucket } from '../fifo/types.js';
import { divRound } from '../money/rounding.js';
import { holdingDays } from '../time/ist.js';
import { ratio, type Ratio } from './ratio.js';

/** One position's facts, as the server assembles them from the vault and the journal. */
export interface TradeFacts {
  readonly positionId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly broker: string;
  readonly bucket: Bucket;
  readonly incomplete: boolean;
  readonly excluded: boolean;
  /** IST date of the first opening fill. */
  readonly openedDateIst: string;
  /** IST date of the final closing fill; null while the position is open. */
  readonly closedDateIst: string | null;
  /** Σ (exit value − entry value) over the position's closed lots. */
  readonly grossMicro: bigint;
  /** Every charge on the position's fills: reported where reconciled, else estimated. */
  readonly chargesMicro: bigint;
  /** True when any of those charges is an estimate. */
  readonly chargesEstimated: boolean;
  /** The opening fills: the buys of a long, the sells of a short (value is the broker's, ADR-0008). */
  readonly entries: readonly { readonly quantity: bigint; readonly valueMicro: bigint }[];
  /** The ₹ amount at risk the user entered in the journal. */
  readonly plannedRiskMicro: bigint | null;
  /** The initial stop per share from the journal. */
  readonly initialStopMicro: bigint | null;
  readonly setupTag: string | null;
  readonly mistakeTags: readonly string[];
}

export interface MetricsOptions {
  /** |net| at or under this is breakeven (`setting.breakeven_threshold_micro`); a negative value counts as 0. */
  readonly breakevenMicro: bigint;
  /** Count INCOMPLETE positions as trades too. */
  readonly includeIncomplete?: boolean;
}

export interface Exclusions {
  /** Closed INCOMPLETE positions left out (none with the toggle on). */
  readonly incomplete: number;
  /** Closed positions the user EXCLUDED (counted here even when also incomplete). */
  readonly excluded: number;
  /** Trades counted, but without an R (no stop and no risk amount). */
  readonly noStop: number;
}

export interface Metrics {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly grossMicro: bigint;
  readonly chargesMicro: bigint;
  readonly netMicro: bigint;
  /** Any counted trade's charges include an estimate: show "estimated". */
  readonly estimated: boolean;
  /** wins / (wins + losses); null when there are neither. */
  readonly winRate: Ratio | null;
  /** Mean net per trade, in micro-rupees (an exact ratio). */
  readonly expectancy: Ratio | null;
  /** Mean net of the wins, in micro-rupees. */
  readonly avgWinner: Ratio | null;
  /** Mean net of the losses, in micro-rupees (negative). */
  readonly avgLoser: Ratio | null;
  /** Σ net wins / |Σ net losses|; "no_losses" when there are wins but no loss to divide by. */
  readonly profitFactor: Ratio | 'no_losses' | null;
  /** Mean of each trade's R rounded to six decimals. */
  readonly avgR: Ratio | null;
  readonly rTrades: number;
  readonly avgHoldingDays: Ratio | null;
  readonly excluded: Exclusions;
}

/** R is averaged in millionths of an R. */
export const R_SCALE = 1_000_000n;

const netOf = (trade: TradeFacts): bigint => trade.grossMicro - trade.chargesMicro;
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);
const mean = (values: readonly bigint[]): Ratio | null =>
  values.length === 0 ? null : ratio(sum(values), BigInt(values.length));

/** The user's amount, else Σ |opening price − initial stop| × qty; null with neither. */
export function plannedRiskOf(trade: TradeFacts): bigint | null {
  if (trade.plannedRiskMicro !== null) return trade.plannedRiskMicro;
  const stop = trade.initialStopMicro;
  if (stop === null) return null;
  // |price − stop| × qty = |value − stop × qty|: exact, with no per-share division.
  return sum(trade.entries.map((entry) => abs(entry.valueMicro - stop * entry.quantity)));
}

/** net ÷ planned risk; null without a stop or an amount, or when the risk is not positive. */
export function rMultiple(trade: TradeFacts): Ratio | null {
  const risk = plannedRiskOf(trade);
  return risk === null || risk <= 0n ? null : ratio(netOf(trade), risk);
}

/**
 * IST calendar days from the first opening to the final closing fill (intraday: 0); an open position has none,
 * and dates in the wrong order (which no recompute produces) count as 0 rather than fail every metric.
 */
export function tradeHoldingDays(trade: TradeFacts): number {
  const { openedDateIst, closedDateIst } = trade;
  return closedDateIst === null || closedDateIst < openedDateIst
    ? 0
    : holdingDays(openedDateIst, closedDateIst);
}

/** The trades a metric counts, and what it left out. */
export function countedTrades(
  trades: readonly TradeFacts[],
  options: MetricsOptions,
): { counted: TradeFacts[]; incomplete: number; excluded: number } {
  const closed = trades.filter((trade) => trade.closedDateIst !== null);
  const kept = closed.filter((trade) => !trade.excluded);
  const counted = options.includeIncomplete === true ? kept : kept.filter((trade) => !trade.incomplete);
  return { counted, incomplete: kept.length - counted.length, excluded: closed.length - kept.length };
}

function profitFactorOf(winSum: bigint, lossSum: bigint, wins: number): Metrics['profitFactor'] {
  if (lossSum !== 0n) return ratio(winSum, -lossSum);
  return wins > 0 ? 'no_losses' : null;
}

export function computeMetrics(trades: readonly TradeFacts[], options: MetricsOptions): Metrics {
  const { counted, incomplete, excluded } = countedTrades(trades, options);
  const threshold = options.breakevenMicro > 0n ? options.breakevenMicro : 0n;
  const nets = counted.map(netOf);
  const wins = nets.filter((value) => value > threshold);
  const losses = nets.filter((value) => -value > threshold);
  const rs = counted.flatMap((trade) => {
    const r = rMultiple(trade);
    return r === null ? [] : [divRound(r.num * R_SCALE, r.den, 'half-up')];
  });
  const decided = wins.length + losses.length;
  return {
    trades: counted.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: counted.length - decided,
    grossMicro: sum(counted.map((trade) => trade.grossMicro)),
    chargesMicro: sum(counted.map((trade) => trade.chargesMicro)),
    netMicro: sum(nets),
    estimated: counted.some((trade) => trade.chargesEstimated),
    winRate: decided === 0 ? null : ratio(BigInt(wins.length), BigInt(decided)),
    expectancy: mean(nets),
    avgWinner: mean(wins),
    avgLoser: mean(losses),
    profitFactor: profitFactorOf(sum(wins), sum(losses), wins.length),
    avgR: rs.length === 0 ? null : ratio(sum(rs), BigInt(rs.length) * R_SCALE),
    rTrades: rs.length,
    avgHoldingDays: mean(counted.map((trade) => BigInt(tradeHoldingDays(trade)))),
    excluded: { incomplete, excluded, noStop: counted.length - rs.length },
  };
}

export type SliceKey = 'setup' | 'mistake' | 'profile' | 'account' | 'broker' | 'bucket' | 'month';

/** The slice key of trades without a setup tag (tag names are never empty). */
export const NO_SETUP = '';

/** The slice values of a trade; a trade can sit in several (one per distinct mistake tag) or none. */
function sliceValues(trade: TradeFacts, by: SliceKey): readonly string[] {
  switch (by) {
    case 'setup':
      return [trade.setupTag ?? NO_SETUP];
    case 'mistake':
      return [...new Set(trade.mistakeTags)];
    case 'profile':
      return [trade.profileId];
    case 'account':
      return [trade.accountId];
    case 'broker':
      return [trade.broker];
    case 'bucket':
      return [trade.bucket];
    case 'month':
      return trade.closedDateIst === null ? [] : [trade.closedDateIst.slice(0, 7)];
  }
}

/** Metrics per slice value, in order of first appearance; each slice carries its own exclusion counts. */
export function sliceTrades(
  trades: readonly TradeFacts[],
  by: SliceKey,
  options: MetricsOptions,
): Map<string, Metrics> {
  // Local arrays, appended in place: one pass, never re-copied.
  const groups = new Map<string, TradeFacts[]>();
  for (const trade of trades) {
    for (const value of sliceValues(trade, by)) {
      const group = groups.get(value);
      if (group === undefined) groups.set(value, [trade]);
      else group.push(trade);
    }
  }
  return new Map([...groups].map(([value, group]) => [value, computeMetrics(group, options)]));
}

/** Σ net P&L of the counted trades tagged with each mistake (a trade with two mistakes counts in both). */
export function costOfMistakes(
  trades: readonly TradeFacts[],
  options: MetricsOptions,
): Map<string, { trades: number; netMicro: bigint }> {
  return new Map(
    [...sliceTrades(trades, 'mistake', options)]
      .filter(([, metrics]) => metrics.trades > 0)
      .map(([tag, metrics]) => [tag, { trades: metrics.trades, netMicro: metrics.netMicro }]),
  );
}
