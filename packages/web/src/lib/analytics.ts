// The dashboard's numbers (PRD §9; plan S15b): the analytics response, checked, with money and ratios as bigint. The
// filters live in the URL, so a view can be bookmarked. Ratios stay exact until display (core's formatRatio).
import { divRound } from '@bhavbook/core/money';
import { formatRatio, type Ratio } from '@bhavbook/core/ratio';
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const unexpected = (): never => {
  throw new ApiError(200, 'unexpected_response');
};
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : unexpected());
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : unexpected());
const str = (value: unknown): string => (typeof value === 'string' ? value : unexpected());
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : unexpected();
const big = (value: unknown): bigint =>
  typeof value === 'string' && /^-?\d{1,30}$/.test(value) ? BigInt(value) : unexpected();
const bool = (value: unknown): boolean => (typeof value === 'boolean' ? value : unexpected());

function ratioOf(value: unknown): Ratio | null {
  if (value === null) return null;
  const row = record(value);
  const den = big(row.den);
  return den > 0n ? { num: big(row.num), den } : unexpected();
}

export interface Metrics {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly grossMicro: bigint;
  readonly chargesMicro: bigint;
  readonly netMicro: bigint;
  readonly estimated: boolean;
  readonly winRate: Ratio | null;
  readonly expectancy: Ratio | null;
  readonly avgWinner: Ratio | null;
  readonly avgLoser: Ratio | null;
  readonly profitFactor: Ratio | 'no_losses' | null;
  readonly avgR: Ratio | null;
  readonly rTrades: number;
  readonly avgHoldingDays: Ratio | null;
  readonly excluded: { readonly incomplete: number; readonly excluded: number; readonly noStop: number };
}

function metrics(value: unknown): Metrics {
  const row = record(value);
  const excluded = record(row.excluded);
  return {
    trades: num(row.trades),
    wins: num(row.wins),
    losses: num(row.losses),
    breakevens: num(row.breakevens),
    grossMicro: big(row.grossMicro),
    chargesMicro: big(row.chargesMicro),
    netMicro: big(row.netMicro),
    estimated: bool(row.estimated),
    winRate: ratioOf(row.winRate),
    expectancy: ratioOf(row.expectancy),
    avgWinner: ratioOf(row.avgWinner),
    avgLoser: ratioOf(row.avgLoser),
    profitFactor: row.profitFactor === 'no_losses' ? 'no_losses' : ratioOf(row.profitFactor),
    avgR: ratioOf(row.avgR),
    rTrades: num(row.rTrades),
    avgHoldingDays: ratioOf(row.avgHoldingDays),
    excluded: {
      incomplete: num(excluded.incomplete),
      excluded: num(excluded.excluded),
      noStop: num(excluded.noStop),
    },
  };
}

export interface Day {
  readonly date: string;
  readonly lots: number;
  readonly netMicro: bigint;
  readonly cumulativeMicro: bigint;
}

export interface Month {
  readonly month: string;
  readonly lots: number;
  readonly grossMicro: bigint;
  readonly chargesMicro: bigint;
  readonly netMicro: bigint;
}

export interface Slice {
  readonly tag: string | null;
  readonly metrics: Metrics;
}

export interface Analytics {
  readonly breakevenMicro: bigint;
  readonly includeIncomplete: boolean;
  readonly summary: Metrics;
  readonly days: readonly Day[];
  readonly months: readonly Month[];
  readonly bySetup: readonly Slice[];
  readonly byMistake: readonly Slice[];
  readonly mistakeCost: readonly {
    readonly tag: string;
    readonly trades: number;
    readonly netMicro: bigint;
  }[];
}

export function analyticsOf(body: unknown): Analytics {
  const value = record(body);
  const slice = (entry: unknown): Slice => {
    const row = record(entry);
    return { tag: row.tag === null ? null : str(row.tag), metrics: metrics(row.metrics) };
  };
  return {
    breakevenMicro: big(value.breakevenMicro),
    includeIncomplete: bool(value.includeIncomplete),
    summary: metrics(value.summary),
    days: list(value.days).map((entry) => {
      const row = record(entry);
      return {
        date: str(row.date),
        lots: num(row.lots),
        netMicro: big(row.netMicro),
        cumulativeMicro: big(row.cumulativeMicro),
      };
    }),
    months: list(value.months).map((entry) => {
      const row = record(entry);
      return {
        month: str(row.month),
        lots: num(row.lots),
        grossMicro: big(row.grossMicro),
        chargesMicro: big(row.chargesMicro),
        netMicro: big(row.netMicro),
      };
    }),
    bySetup: list(value.bySetup).map(slice),
    byMistake: list(value.byMistake).map(slice),
    mistakeCost: list(value.mistakeCost).map((entry) => {
      const row = record(entry);
      return { tag: str(row.tag), trades: num(row.trades), netMicro: big(row.netMicro) };
    }),
  };
}

/** The dashboard's filters, as the URL carries them (every one optional). */
export interface DashboardFilter {
  readonly profileId?: string;
  readonly accountId?: string;
  readonly broker?: 'zerodha' | 'dhan';
  readonly bucket?: 'DELIVERY' | 'INTRADAY' | 'MTF';
  readonly from?: string;
  readonly to?: string;
  readonly includeIncomplete?: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BROKERS = ['zerodha', 'dhan'] as const;
const BUCKETS = ['DELIVERY', 'INTRADAY', 'MTF'] as const;

const matching = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

/** The filters a URL (or a change in the filter bar) carries; anything else, and anything emptied, is dropped. */
export function dashboardFilterOf(search: Record<string, unknown>): DashboardFilter {
  const profileId = matching(search.profileId, ID);
  const accountId = matching(search.accountId, ID);
  const broker = BROKERS.find((entry) => entry === search.broker);
  const bucket = BUCKETS.find((entry) => entry === search.bucket);
  const from = matching(search.from, DATE);
  const to = matching(search.to, DATE);
  const includeIncomplete = search.includeIncomplete === true || search.includeIncomplete === 'true';
  return {
    ...(profileId === undefined ? {} : { profileId }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(broker === undefined ? {} : { broker }),
    ...(bucket === undefined ? {} : { bucket }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(includeIncomplete ? { includeIncomplete } : {}),
  };
}

export const analyticsQuery = (filter: DashboardFilter) =>
  queryOptions({
    queryKey: ['analytics', filter],
    queryFn: async () => {
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined) query[key] = String(value);
      }
      return analyticsOf(await readJson(await send(() => api.analytics.$get({ query }))));
    },
  });

/** A ratio as a percentage with one decimal ("57.1%"). */
export const percent = (value: Ratio): string =>
  `${formatRatio({ num: value.num * 100n, den: value.den }, 1)}%`;

/** A ratio as a decimal ("1.85"). */
export const decimal = (value: Ratio, places = 2): string => formatRatio(value, places);

/** A micro-rupee ratio (a mean) as whole micro-rupees, rounded half-up, for Money. */
export const microOf = (value: Ratio): bigint => divRound(value.num, value.den, 'half-up');

/** Micro-rupees as rupees for a chart's scale (paise precision; display only, never summed back). */
export const chartRupees = (micro: bigint): number => Number(micro / 10_000n) / 100;
