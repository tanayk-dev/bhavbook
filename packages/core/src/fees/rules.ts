// Fee-rule files (plan S12a task 1, ADR-0016): JSON versioned by effective date, one set per exchange (statutory)
// and per broker plan (brokerage, DP). Every rate is an exact decimal string with its source and the date it was
// checked; the golden tests decide whether a version is right. Rates become exact rationals (ADR-0004).
import { z } from 'zod';
import bseFrom20241001 from '../../rules/statutory/bse/2024-10-01.json' with { type: 'json' };
import nseFrom20240401 from '../../rules/statutory/nse/2024-04-01.json' with { type: 'json' };
import nseFrom20241001 from '../../rules/statutory/nse/2024-10-01.json' with { type: 'json' };
import nseFrom20260301 from '../../rules/statutory/nse/2026-03-01.json' with { type: 'json' };
import dhanFrom20240401 from '../../rules/broker/dhan/2024-04-01.json' with { type: 'json' };
import zerodhaFrom20240401 from '../../rules/broker/zerodha/2024-04-01.json' with { type: 'json' };
import zerodhaFrom20240601 from '../../rules/broker/zerodha/2024-06-01.json' with { type: 'json' };
import { byText, type Bucket, type Side } from '../fifo/types.js';
import { parseDecimalToMicro } from '../money/decimal.js';
import { rateFromPercentString, type Rate } from '../money/rate.js';
import { istDayBounds } from '../time/ist.js';

export class FeeRuleError extends Error {
  override readonly name = 'FeeRuleError';
}

export type FeeExchange = 'NSE' | 'BSE';
export type FeeBroker = 'dhan' | 'zerodha';

/** Brokers BhavBook has fee rules for. */
export function isFeeBroker(broker: string): broker is FeeBroker {
  return broker === 'dhan' || broker === 'zerodha';
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    try {
      istDayBounds(date);
      return true;
    } catch {
      return false;
    }
  });
const sourced = (value: z.ZodString) =>
  z.object({ value, source_url: z.string().regex(/^https:\/\/\S+$/), verified_on: isoDate }).strict();
const percent = sourced(z.string().regex(/^\d+(\.\d+)?%$/));
const rupees = sourced(z.string().regex(/^\d+(\.\d{1,6})?$/));
const sides = z.object({ buy: percent, sell: percent }).strict();
const byBucket = <T extends z.ZodType>(schema: T) =>
  z.object({ DELIVERY: schema, INTRADAY: schema, MTF: schema }).strict();

const statutorySchema = z
  .object({
    kind: z.literal('statutory'),
    exchange: z.enum(['NSE', 'BSE']),
    effective_from: isoDate,
    notes: z.string(),
    stt: byBucket(sides),
    stamp_duty: byBucket(sides),
    exchange_txn: percent,
    sebi: percent,
    ipft: percent,
    gst: percent,
  })
  .strict();

const brokerSchema = z
  .object({
    kind: z.literal('broker'),
    broker: z.enum(['dhan', 'zerodha']),
    effective_from: isoDate,
    notes: z.string(),
    brokerage: byBucket(z.object({ percent, max_rupees: rupees.nullable() }).strict()),
    dp: z.object({ per_scrip_sell_day_rupees: rupees, gst: percent }).strict(),
  })
  .strict();

type SideRates = Readonly<Record<Side, Rate>>;

export interface StatutoryRule {
  /** `<exchange>/<effective date>`, e.g. `nse/2024-10-01`. */
  readonly id: string;
  readonly exchange: FeeExchange;
  readonly effectiveFrom: string;
  readonly stt: Readonly<Record<Bucket, SideRates>>;
  readonly stampDuty: Readonly<Record<Bucket, SideRates>>;
  readonly exchangeTxn: Rate;
  readonly sebi: Rate;
  readonly ipft: Rate;
  readonly gst: Rate;
}

export interface BrokerageRule {
  readonly percent: Rate;
  /** The per-order cap; null when there is none. */
  readonly maxMicro: bigint | null;
}

export interface BrokerRule {
  readonly id: string;
  readonly broker: FeeBroker;
  readonly effectiveFrom: string;
  readonly brokerage: Readonly<Record<Bucket, BrokerageRule>>;
  readonly dpMicro: bigint;
  readonly dpGst: Rate;
}

export interface FeeRules {
  readonly statutory: readonly StatutoryRule[];
  readonly broker: readonly BrokerRule[];
}

type BucketMap<T> = Readonly<Record<Bucket, T>>;

function mapBuckets<T, U>(source: BucketMap<T>, map: (value: T) => U): BucketMap<U> {
  return { DELIVERY: map(source.DELIVERY), INTRADAY: map(source.INTRADAY), MTF: map(source.MTF) };
}

const toSides = (entry: z.infer<typeof sides>): SideRates => ({
  BUY: rateFromPercentString(entry.buy.value),
  SELL: rateFromPercentString(entry.sell.value),
});

function toStatutory(file: z.infer<typeof statutorySchema>): StatutoryRule {
  return {
    id: `${file.exchange.toLowerCase()}/${file.effective_from}`,
    exchange: file.exchange,
    effectiveFrom: file.effective_from,
    stt: mapBuckets(file.stt, toSides),
    stampDuty: mapBuckets(file.stamp_duty, toSides),
    exchangeTxn: rateFromPercentString(file.exchange_txn.value),
    sebi: rateFromPercentString(file.sebi.value),
    ipft: rateFromPercentString(file.ipft.value),
    gst: rateFromPercentString(file.gst.value),
  };
}

function toBroker(file: z.infer<typeof brokerSchema>): BrokerRule {
  return {
    id: `${file.broker}/${file.effective_from}`,
    broker: file.broker,
    effectiveFrom: file.effective_from,
    brokerage: mapBuckets(file.brokerage, (entry) => ({
      percent: rateFromPercentString(entry.percent.value),
      maxMicro: entry.max_rupees === null ? null : parseDecimalToMicro(entry.max_rupees.value),
    })),
    dpMicro: parseDecimalToMicro(file.dp.per_scrip_sell_day_rupees.value),
    dpGst: rateFromPercentString(file.dp.gst.value),
  };
}

const fileSchema = z.discriminatedUnion('kind', [statutorySchema, brokerSchema]);

const byId = (a: { readonly id: string }, b: { readonly id: string }): number => byText(a.id, b.id);

/** Validates rule files (statutory and broker, any order). Versions are unique per exchange or broker and date. */
export function parseFeeRules(files: readonly unknown[]): FeeRules {
  const statutory: StatutoryRule[] = [];
  const broker: BrokerRule[] = [];
  for (const [index, file] of files.entries()) {
    const parsed = fileSchema.safeParse(file);
    if (!parsed.success) {
      // Paths and zod's messages only (rule files hold no personal data).
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ');
      throw new FeeRuleError(`invalid fee rule file #${String(index)}: ${issues}`);
    }
    if (parsed.data.kind === 'statutory') statutory.push(toStatutory(parsed.data));
    else broker.push(toBroker(parsed.data));
  }
  const ids = [...statutory, ...broker].map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) {
    throw new FeeRuleError('two fee rule versions with the same effective date');
  }
  return Object.freeze({
    statutory: Object.freeze(statutory.sort(byId)),
    broker: Object.freeze(broker.sort(byId)),
  });
}

const BUNDLED: readonly unknown[] = [
  bseFrom20241001,
  nseFrom20240401,
  nseFrom20241001,
  nseFrom20260301,
  dhanFrom20240401,
  zerodhaFrom20240401,
  zerodhaFrom20240601,
];

let bundled: FeeRules | undefined;

/** The rule files shipped with BhavBook (packages/core/rules), parsed once. */
export function bundledFeeRules(): FeeRules {
  bundled ??= parseFeeRules(BUNDLED);
  return bundled;
}

/** The version with the latest effective date on or before `date` (whatever the order of `versions`). */
function inForce<T extends { readonly effectiveFrom: string }>(
  versions: readonly T[],
  date: string,
): T | null {
  let latest: T | null = null;
  for (const rule of versions) {
    if (rule.effectiveFrom <= date && (latest === null || rule.effectiveFrom > latest.effectiveFrom))
      latest = rule;
  }
  return latest;
}

export interface SelectedRules {
  readonly statutory: StatutoryRule;
  readonly broker: BrokerRule;
}

/** The versions in force on `date` (never "latest"); null when either has no version yet. */
export function selectFeeRules(
  rules: FeeRules,
  broker: FeeBroker,
  exchange: FeeExchange,
  date: string,
): SelectedRules | null {
  const statutory = inForce(
    rules.statutory.filter((rule) => rule.exchange === exchange),
    date,
  );
  const plan = inForce(
    rules.broker.filter((rule) => rule.broker === broker),
    date,
  );
  return statutory === null || plan === null ? null : { statutory, broker: plan };
}
