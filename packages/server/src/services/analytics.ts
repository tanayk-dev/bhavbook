// The dashboard's analytics (PRD §9, ADR-0025; plan S15b): the server assembles each position's facts and each
// closed lot from the vault, and core computes the metrics. A trade is a closed, complete, non-excluded position
// (incomplete ones only with the toggle); the realisation views (equity curve, monthly P&L, calendar) date each
// closed lot by its exit, so partial exits count when they happened, from positions the same rule admits. Charges
// are effective (reported where a statement covers them, else estimated) and a lot carries its share of its fills'
// charges. The vault's facts are built once (five whole-table passes, none per position) and kept until the vault
// changes; each request then filters and computes in memory, so changing a filter stays fast on a large vault.
import {
  apportionLotCharges,
  computeMetrics,
  costOfMistakes,
  istDateOf,
  NO_SETUP,
  realisedBy,
  sliceTrades,
  type Bucket,
  type LotLink,
  type Metrics,
  type RealisedLot,
  type TradeFacts,
} from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { breakevenThresholdMicro } from './settings.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const analyticsFilterSchema = z
  .object({
    profileId: z.string().regex(ID).optional(),
    accountId: z.string().regex(ID).optional(),
    broker: z.enum(['zerodha', 'dhan']).optional(),
    bucket: z.enum(['DELIVERY', 'INTRADAY', 'MTF']).optional(),
    /** IST dates, inclusive: trades by the day they closed, realised lots by their exit day. */
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
    includeIncomplete: z.enum(['true', 'false']).optional(),
  })
  .strict();

export type AnalyticsFilter = z.input<typeof analyticsFilterSchema>;

interface PositionRow {
  readonly id: string;
  readonly account_id: string;
  readonly profile_id: string;
  readonly broker: string;
  readonly bucket: Bucket;
  readonly incomplete: bigint;
  readonly excluded: bigint;
  readonly opened_at_utc: string;
  readonly closed_at_utc: string | null;
}

interface LotRow {
  readonly id: bigint;
  readonly position_id: string;
  readonly entry_allocation_id: bigint;
  readonly exit_allocation_id: bigint | null;
  readonly quantity: bigint;
  readonly entry_value_micro: bigint;
  readonly exit_value_micro: bigint | null;
  readonly exit_date_ist: string | null;
}

interface JournalRow {
  readonly position_id: string;
  readonly initial_stop_micro: bigint | null;
  readonly planned_risk_micro: bigint | null;
  readonly setup: string | null;
  readonly mistakes: string | null;
}

interface Loaded {
  readonly positions: PositionRow[];
  readonly lots: LotRow[];
  /** By fill allocation id (bigint keys compare by value). */
  readonly charges: Map<bigint, { amount: bigint; estimated: boolean }>;
  readonly entries: Map<bigint, { quantity: bigint; valueMicro: bigint }>;
  readonly journal: Map<string, JournalRow>;
}

/**
 * Each fill's effective charges, from one plain scan (EFFECTIVE_CHARGES_SQL's rule): per fill and component the
 * reported amount when a statement covers it, else the estimate; `estimated` when any component is an estimate.
 */
function fillCharges(db: Database.Database): Map<bigint, { amount: bigint; estimated: boolean }> {
  const rows = db
    .prepare('SELECT fill_allocation_id, component, source, amount_micro FROM fill_charge NOT INDEXED')
    .raw(true)
    .all() as [bigint, string, 'estimated' | 'reported', bigint][];
  const byFill = new Map<bigint, Map<string, { reported: bigint | null; estimated: bigint }>>();
  for (const [fill, component, source, amount] of rows) {
    let components = byFill.get(fill);
    if (components === undefined) {
      components = new Map();
      byFill.set(fill, components);
    }
    const current = components.get(component) ?? { reported: null, estimated: 0n };
    components.set(
      component,
      source === 'reported'
        ? { ...current, reported: (current.reported ?? 0n) + amount }
        : { ...current, estimated: current.estimated + amount },
    );
  }
  const charges = new Map<bigint, { amount: bigint; estimated: boolean }>();
  for (const [fill, components] of byFill) {
    let amount = 0n;
    let estimated = false;
    for (const component of components.values()) {
      amount += component.reported ?? component.estimated;
      estimated ||= component.reported === null;
    }
    charges.set(fill, { amount, estimated });
  }
  return charges;
}

/** Everything about the vault's positions, in five whole-table passes (none per position). */
function load(db: Database.Database): Loaded {
  const positions = db
    .prepare(
      `SELECT p.id, p.account_id, b.profile_id, b.broker, p.bucket, p.incomplete, p.excluded, p.opened_at_utc,
         p.closed_at_utc
       FROM position p JOIN broker_account b ON b.id = p.account_id`,
    )
    .all() as PositionRow[];
  const lots = db
    .prepare(
      `SELECT id, position_id, entry_allocation_id, exit_allocation_id, quantity, entry_value_micro,
         exit_value_micro, exit_date_ist FROM lot`,
    )
    .all() as LotRow[];
  const entryRows = db
    .prepare(
      `SELECT id, quantity, value_micro FROM fill_allocation WHERE id IN (SELECT entry_allocation_id FROM lot)`,
    )
    .all() as { id: bigint; quantity: bigint; value_micro: bigint }[];
  // The oldest entry on a position (two colliding entries wait in the inbox; the first is the one shown).
  const journalRows = db
    .prepare(
      `SELECT a.position_id, e.initial_stop_micro, e.planned_risk_micro, s.name AS setup,
         (SELECT json_group_array(t.name) FROM journal_tag l JOIN tag t ON t.id = l.tag_id
          WHERE l.journal_entry_id = e.id AND t.kind = 'mistake') AS mistakes
       FROM journal_attachment a JOIN journal_entry e ON e.id = a.journal_entry_id
       LEFT JOIN tag s ON s.id = e.setup_tag_id
       ORDER BY a.position_id, e.created_at DESC, e.id DESC`,
    )
    .all() as JournalRow[];
  return {
    positions,
    lots,
    charges: fillCharges(db),
    entries: new Map(
      entryRows.map((row) => [row.id, { quantity: row.quantity, valueMicro: row.value_micro }]),
    ),
    // Later rows (older entries) win: the map keeps the oldest per position.
    journal: new Map(journalRows.map((row) => [row.position_id, row])),
  };
}

function mistakesOf(json: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/** Each position's facts for core. */
function tradeFacts(loaded: Loaded): TradeFacts[] {
  const lotsOf = new Map<string, LotRow[]>();
  for (const lot of loaded.lots) {
    const group = lotsOf.get(lot.position_id);
    if (group === undefined) lotsOf.set(lot.position_id, [lot]);
    else group.push(lot);
  }
  return loaded.positions.map((position) => {
    const lots = lotsOf.get(position.id) ?? [];
    // One pass over the lots: a fill shared by two lots counts its charges once.
    const fills = new Set<bigint>();
    const entryIds = new Set<bigint>();
    let grossMicro = 0n;
    for (const lot of lots) {
      fills.add(lot.entry_allocation_id);
      entryIds.add(lot.entry_allocation_id);
      if (lot.exit_allocation_id !== null) fills.add(lot.exit_allocation_id);
      if (lot.exit_value_micro !== null) grossMicro += lot.exit_value_micro - lot.entry_value_micro;
    }
    let chargesMicro = 0n;
    let chargesEstimated = false;
    for (const id of fills) {
      const charge = loaded.charges.get(id);
      if (charge === undefined) continue;
      chargesMicro += charge.amount;
      chargesEstimated ||= charge.estimated;
    }
    const entries: { quantity: bigint; valueMicro: bigint }[] = [];
    for (const id of entryIds) {
      const entry = loaded.entries.get(id);
      if (entry !== undefined) entries.push(entry);
    }
    const journal = loaded.journal.get(position.id);
    return {
      positionId: position.id,
      accountId: position.account_id,
      profileId: position.profile_id,
      broker: position.broker,
      bucket: position.bucket,
      incomplete: position.incomplete === 1n,
      excluded: position.excluded === 1n,
      openedDateIst: istDateOf(position.opened_at_utc),
      closedDateIst: position.closed_at_utc === null ? null : istDateOf(position.closed_at_utc),
      grossMicro,
      chargesMicro,
      chargesEstimated,
      entries,
      plannedRiskMicro: journal?.planned_risk_micro ?? null,
      initialStopMicro: journal?.initial_stop_micro ?? null,
      setupTag: journal?.setup ?? null,
      mistakeTags: mistakesOf(journal?.mistakes ?? null),
    };
  });
}

/** Every closed lot, with its share of its fills' charges. */
function realisedLots(loaded: Loaded): RealisedLot[] {
  const links: LotLink[] = loaded.lots.map((lot) => ({
    lotKey: lot.id.toString(),
    entry: lot.entry_allocation_id.toString(),
    exit: lot.exit_allocation_id?.toString() ?? null,
    quantity: lot.quantity,
  }));
  const { shares } = apportionLotCharges(
    new Map([...loaded.charges].map(([id, charge]) => [id.toString(), charge.amount])),
    links,
  );
  return loaded.lots.flatMap((lot) =>
    lot.exit_value_micro === null || lot.exit_date_ist === null
      ? []
      : [
          {
            positionId: lot.position_id,
            exitDateIst: lot.exit_date_ist,
            grossMicro: lot.exit_value_micro - lot.entry_value_micro,
            chargesMicro: shares.get(lot.id.toString()) ?? 0n,
          },
        ],
  );
}

export interface DayPoint {
  readonly date: string;
  readonly lots: number;
  readonly netMicro: bigint;
  /** Realised net from the first day in range to this one. */
  readonly cumulativeMicro: bigint;
}

export interface MonthPoint {
  readonly month: string;
  readonly lots: number;
  readonly grossMicro: bigint;
  readonly chargesMicro: bigint;
  readonly netMicro: bigint;
}

export interface Slice {
  /** The tag's name; null for trades without a setup. */
  readonly tag: string | null;
  readonly metrics: Metrics;
}

export interface Analytics {
  readonly breakevenMicro: bigint;
  readonly includeIncomplete: boolean;
  readonly summary: Metrics;
  readonly days: DayPoint[];
  readonly months: MonthPoint[];
  readonly bySetup: Slice[];
  readonly byMistake: Slice[];
  /** Σ net of the trades tagged with each mistake. */
  readonly mistakeCost: { readonly tag: string; readonly trades: number; readonly netMicro: bigint }[];
}

interface VaultFacts {
  readonly facts: TradeFacts[];
  readonly lots: RealisedLot[];
}

/**
 * The vault's facts, built once and kept until the vault changes (stateOf); a restore opens a new connection, a new
 * key, and the old entry goes with the old connection.
 */
const built = new WeakMap<Database.Database, { readonly version: string; readonly facts: VaultFacts }>();

/**
 * What identifies the vault's state: this connection's own writes (`total_changes()`, which also counts triggers
 * and cascades) and any other connection's commits (`data_version`, which this connection's own writes leave alone).
 */
function stateOf(db: Database.Database): string {
  const changes: unknown = db.prepare('SELECT total_changes()').pluck().get();
  // The vault's connections read integers as bigint (vault/schema.ts); anything else would break the bigint sums.
  if (typeof changes !== 'bigint') throw new Error('analytics needs a vault connection (safe integers)');
  const version: unknown = db.pragma('data_version', { simple: true });
  return `${changes.toString()}:${String(version)}`;
}

function vaultFacts(db: Database.Database): VaultFacts {
  const version = stateOf(db);
  const cached = built.get(db);
  if (cached?.version === version) return cached.facts;
  const loaded = db.transaction(() => load(db))();
  const facts = { facts: tradeFacts(loaded), lots: realisedLots(loaded) };
  built.set(db, { version, facts });
  return facts;
}

const inRange = (date: string | null, from: string | undefined, to: string | undefined): boolean =>
  date !== null && (from === undefined || date >= from) && (to === undefined || date <= to);

/** The dashboard's numbers for a filter. */
export function analytics(db: Database.Database, filter: AnalyticsFilter = {}): Analytics {
  const parsed = analyticsFilterSchema.parse(filter);
  const includeIncomplete = parsed.includeIncomplete === 'true';
  const options = { breakevenMicro: breakevenThresholdMicro(db), includeIncomplete };
  const { facts, lots: allLots } = vaultFacts(db);
  const inScope = (trade: TradeFacts): boolean =>
    (parsed.profileId === undefined || trade.profileId === parsed.profileId) &&
    (parsed.accountId === undefined || trade.accountId === parsed.accountId) &&
    (parsed.broker === undefined || trade.broker === parsed.broker) &&
    (parsed.bucket === undefined || trade.bucket === parsed.bucket);
  const scoped = facts.filter(inScope);
  // Trades by the day they closed; open positions stay in for the realised lots of their partial exits.
  const trades = scoped.filter(
    (trade) => trade.closedDateIst === null || inRange(trade.closedDateIst, parsed.from, parsed.to),
  );
  const admitted = new Set(
    scoped
      .filter((trade) => !trade.excluded && (includeIncomplete || !trade.incomplete))
      .map((trade) => trade.positionId),
  );
  const lots = allLots.filter(
    (lot) => admitted.has(lot.positionId) && inRange(lot.exitDateIst, parsed.from, parsed.to),
  );
  let cumulative = 0n;
  const days = [...realisedBy(lots, 'day')].map(([date, day]) => {
    cumulative += day.netMicro;
    return { date, lots: day.lots, netMicro: day.netMicro, cumulativeMicro: cumulative };
  });
  const months = [...realisedBy(lots, 'month')].map(([month, total]) => ({ month, ...total }));
  const slices = (by: 'setup' | 'mistake'): Slice[] =>
    [...sliceTrades(trades, by, options)]
      .filter(([, metrics]) => metrics.trades > 0)
      .map(([tag, metrics]) => ({ tag: tag === NO_SETUP && by === 'setup' ? null : tag, metrics }))
      .sort((a, b) => b.metrics.trades - a.metrics.trades || ((a.tag ?? '') < (b.tag ?? '') ? -1 : 1));
  return {
    breakevenMicro: options.breakevenMicro,
    includeIncomplete,
    summary: computeMetrics(trades, options),
    days,
    months,
    bySetup: slices('setup'),
    byMistake: slices('mistake'),
    mistakeCost: [...costOfMistakes(trades, options)]
      .map(([tag, cost]) => ({ tag, ...cost }))
      .sort((a, b) => (a.netMicro < b.netMicro ? -1 : a.netMicro > b.netMicro ? 1 : 0)),
  };
}
