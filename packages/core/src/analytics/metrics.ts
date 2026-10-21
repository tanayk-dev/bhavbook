// Trade analytics (S15a, PRD §9, ADR-0025). A trade is a CLOSED, non-excluded, complete position; incomplete ones
// count only with the toggle. Net = gross − all charges (reported where reconciled, else estimated: the caller
// passes the effective charges). Win / loss is by net; |net| ≤ the breakeven threshold is breakeven, a trade that is
// left out of the win rate. R = net ÷ planned risk: the user's amount, else Σ over entries of
// |entry price − initial stop| × qty, so moving the stop later never changes R.
import type { Bucket } from '../fifo/types.js';
import { holdingDays } from '../time/ist.js';
import { meanRatio, ratio, type Ratio } from './ratio.js';

/** One position's facts, as the server assembles them from the vault and the journal. */
export interface TradeFacts {
  readonly positionId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly broker: string;
  readonly bucket: Bucket;
  readonly closed: boolean;
  readonly incomplete: boolean;
  readonly excluded: boolean;
  /** IST date of the first entry fill. */
  readonly openedDateIst: string;
  /** IST date of the final exit fill; null while open. */
  readonly closedDateIst: string | null;
  /** Σ (exit value − entry value) over the position's closed lots. */
  readonly grossMicro: bigint;
  /** Every charge on the position's fills: reported where reconciled, else estimated. */
  readonly chargesMicro: bigint;
  /** True when any of those charges is an estimate. */
  readonly chargesEstimated: boolean;
  /** The entry fills (value is the broker's trade value, ADR-0008). */
  readonly entries: readonly { readonly quantity: bigint; readonly valueMicro: bigint }[];
  /** The ₹ amount at risk the user entered in the journal. */
  readonly plannedRiskMicro: bigint | null;
  /** The initial stop per share from the journal. */
  readonly initialStopMicro: bigint | null;
  readonly setupTag: string | null;
  readonly mistakeTags: readonly string[];
}

export interface MetricsOptions {
  /** |net| at or under this is breakeven (`setting.breakeven_threshold_micro`). */
  readonly breakevenMicro: bigint;
  /** Count INCOMPLETE positions as trades too. */
  readonly includeIncomplete?: boolean;
}

export interface Exclusions {
  /** Closed INCOMPLETE positions left out (none with the toggle on). */
  readonly incomplete: number;
  /** Closed positions the user EXCLUDED. */
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
  /** Σ net wins / |Σ net losses|; "no_losses" when there is no loss to divide by. */
  readonly profitFactor: Ratio | 'no_losses' | null;
  readonly avgR: Ratio | null;
  readonly rTrades: number;
  readonly avgHoldingDays: Ratio | null;
  readonly excluded: Exclusions;
}

const netOf = (trade: TradeFacts): bigint => trade.grossMicro - trade.chargesMicro;
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);
const mean = (values: readonly bigint[]): Ratio | null =>
  values.length === 0 ? null : ratio(sum(values), BigInt(values.length));

/** The user's amount, else Σ |entry price − initial stop| × qty; null with neither. */
export function plannedRiskMicro(trade: TradeFacts): bigint | null {
  if (trade.plannedRiskMicro !== null) return trade.plannedRiskMicro;
  const stop = trade.initialStopMicro;
  if (stop === null) return null;
  // |price − stop| × qty = |value − stop × qty|: exact, with no per-share division.
  return sum(trade.entries.map((entry) => abs(entry.valueMicro - stop * entry.quantity)));
}

/** net ÷ planned risk; null without a stop or an amount, or when the risk is zero. */
export function rMultiple(trade: TradeFacts): Ratio | null {
  const risk = plannedRiskMicro(trade);
  return risk === null || risk === 0n ? null : ratio(netOf(trade), risk);
}

/** IST calendar days from the first entry to the final exit (intraday: 0); an open position has none. */
export function tradeHoldingDays(trade: TradeFacts): number {
  return trade.closedDateIst === null ? 0 : holdingDays(trade.openedDateIst, trade.closedDateIst);
}

/** The trades a metric counts, and what it left out. */
export function countedTrades(
  trades: readonly TradeFacts[],
  options: MetricsOptions,
): { counted: TradeFacts[]; incomplete: number; excluded: number } {
  const closed = trades.filter((trade) => trade.closed);
  const excluded = closed.filter((trade) => trade.excluded).length;
  const kept = closed.filter((trade) => !trade.excluded);
  const counted = options.includeIncomplete === true ? kept : kept.filter((trade) => !trade.incomplete);
  return { counted, incomplete: kept.length - counted.length, excluded };
}

export function computeMetrics(trades: readonly TradeFacts[], options: MetricsOptions): Metrics {
  const { counted, incomplete, excluded } = countedTrades(trades, options);
  const nets = counted.map(netOf);
  const wins = nets.filter((value) => value > 0n && value > options.breakevenMicro);
  const losses = nets.filter((value) => value < 0n && -value > options.breakevenMicro);
  const rs = counted.flatMap((trade) => {
    const r = rMultiple(trade);
    return r === null ? [] : [r];
  });
  const winSum = sum(wins);
  const lossSum = sum(losses);
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
    profitFactor: lossSum !== 0n ? ratio(winSum, -lossSum) : wins.length > 0 ? 'no_losses' : null,
    avgR: meanRatio(rs),
    rTrades: rs.length,
    avgHoldingDays: mean(counted.map((trade) => BigInt(tradeHoldingDays(trade)))),
    excluded: { incomplete, excluded, noStop: counted.length - rs.length },
  };
}

export type SliceKey = 'setup' | 'mistake' | 'profile' | 'account' | 'broker' | 'bucket' | 'month';

/** The slice values of a trade; a trade can sit in several (one per mistake tag) or none. */
function sliceValues(trade: TradeFacts, by: SliceKey): readonly string[] {
  switch (by) {
    case 'setup':
      return [trade.setupTag ?? '(none)'];
    case 'mistake':
      return trade.mistakeTags;
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
  const groups = new Map<string, TradeFacts[]>();
  for (const trade of trades) {
    for (const value of sliceValues(trade, by)) groups.set(value, [...(groups.get(value) ?? []), trade]);
  }
  return new Map([...groups].map(([value, group]) => [value, computeMetrics(group, options)]));
}

/** Σ net P&L of the counted trades tagged with each mistake (a trade with two mistakes counts in both). */
export function costOfMistakes(
  trades: readonly TradeFacts[],
  options: MetricsOptions,
): Map<string, { trades: number; netMicro: bigint }> {
  const { counted } = countedTrades(trades, options);
  const costs = new Map<string, { trades: number; netMicro: bigint }>();
  for (const trade of counted) {
    for (const tag of trade.mistakeTags) {
      const cost = costs.get(tag) ?? { trades: 0, netMicro: 0n };
      costs.set(tag, { trades: cost.trades + 1, netMicro: cost.netMicro + netOf(trade) });
    }
  }
  return costs;
}
