// Reconciliation in recompute (S12b, ADR-0017, PRD §8.2). Statement-reported charges hang off allocations, which
// every recompute rebuilds, so they are re-derived from the stored statement rows each time (plan r12): reported
// charges are written next to the estimates, every position gets its charge_reconciliation status, and differences
// become issues. The FIFO cross-check compares the broker's tax-report lots with ours.
import {
  crossCheckLots,
  positionChargeStatus,
  reconcileCharges,
  type ChargeDiscrepancy,
  type ChargedAllocation,
  type ChargeableFill,
  type DateRange,
  type EstimatedCharge,
  type FillAllocation,
  type FillCharge,
  type LotFacts,
  type Position,
  type ReconciledComponent,
  type ReconcileResult,
  type StatementChargeRow,
} from '@bhavbook/core';
import type Database from 'better-sqlite3';

/** Global Transactions columns, by component (adapters/dhan/statements.ts). */
const COMPONENTS: readonly ReconciledComponent[] = [
  'brokerage',
  'stt',
  'exchange_txn',
  'sebi',
  'ipft',
  'stamp_duty',
  'gst',
];
const GT_FIELDS: Readonly<Record<ReconciledComponent, string>> = {
  brokerage: 'brokerage_micro',
  stt: 'stt_micro',
  exchange_txn: 'txn_micro',
  sebi: 'sebi_micro',
  ipft: 'other_micro',
  stamp_duty: 'stamp_duty_micro',
  gst: 'gst_micro',
};
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
/** Issue subjects hold micro-rupees as exact decimal strings. */
const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
const MICRO = /^-?\d{1,19}$/;

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The date ranges an account's imports of one report kind cover. */
function coverageOf(db: Database.Database, accountId: string, kinds: readonly string[]): DateRange[] {
  return (
    db
      .prepare(
        `SELECT coverage_from AS "from", coverage_to AS "to" FROM import_batch
         WHERE account_id = ? AND coverage_from IS NOT NULL AND coverage_to IS NOT NULL
           AND report_kind IN (${kinds.map(() => '?').join(', ')})`,
      )
      .all(accountId, ...kinds) as DateRange[]
  ).map(({ from, to }) => ({ from, to }));
}

/** Global Transactions rows, keyed to instruments the way trade rows are (an alias, else a local key). */
function chargeRows(
  db: Database.Database,
  accountId: string,
  aliases: ReadonlyMap<string, string>,
): { rows: StatementChargeRow[]; unreadable: number } {
  const stored = db
    .prepare("SELECT key_json, data_json FROM statement_row WHERE account_id = ? AND kind = 'dhan.gt.row'")
    .all(accountId) as { key_json: string; data_json: string }[];
  const rows: StatementChargeRow[] = [];
  let unreadable = 0;
  for (const row of stored) {
    const key = parseJson(row.key_json);
    const data = parseJson(row.data_json);
    const date = text(key?.date);
    const name = text(key?.name);
    const amounts: Partial<Record<ReconciledComponent, bigint>> = {};
    for (const component of COMPONENTS) {
      const value = data?.[GT_FIELDS[component]];
      if (typeof value === 'string' && MICRO.test(value)) amounts[component] = BigInt(value);
    }
    // A stored row that can't be read must not look like a trade the broker didn't bill: it is counted and reported.
    if (date === null || name === null || Object.keys(amounts).length !== COMPONENTS.length) {
      unreadable += 1;
      continue;
    }
    const exchange = text(key?.exchange) ?? '';
    rows.push({ dateIst: date, exchange, instrumentKey: aliases.get(name) ?? `local:dhan:${name}`, amounts });
  }
  return { rows, unreadable };
}

/** The imported allocation a part came from: the key before the first `~` (fees/account.ts). */
const rootOf = (key: string): string => key.split('~')[0] ?? key;
/** The trade row id an imported allocation key (`<fill id>#<bucket>`) belongs to. */
const fillIdOf = (key: string): string => rootOf(key).split('#')[0] ?? '';

/**
 * Allocations placed by the imported trade behind them: a corporate action's reshaped and demerged parts carry a
 * share of that trade's charges, so they are placed by it too. Opening lots carry no charges.
 */
function placeAllocations(
  fills: ReadonlyMap<string, ChargeableFill>,
  allocations: readonly FillAllocation[],
): Map<string, ChargedAllocation> {
  const placed = new Map<string, ChargedAllocation>();
  for (const allocation of allocations) {
    const fill = allocation.adjustmentId === null ? fills.get(fillIdOf(allocation.key)) : undefined;
    if (fill === undefined) continue;
    placed.set(allocation.key, {
      allocationKey: allocation.key,
      dateIst: fill.tradeDateIst,
      exchange: fill.exchange,
      instrumentKey: fill.instrumentKey,
      valueMicro: allocation.valueMicro,
    });
  }
  return placed;
}

/** The engine's estimates placed by their trade, with the shares of cashed-out shares (no allocation) included. */
function placeEstimates(
  fills: ReadonlyMap<string, ChargeableFill>,
  charges: readonly FillCharge[],
  unattached: readonly FillCharge[],
): EstimatedCharge[] {
  const place = (charge: FillCharge, allocationKey: string | null): EstimatedCharge[] => {
    const fill = fills.get(fillIdOf(charge.allocationKey));
    if (fill === undefined) return [];
    const { tradeDateIst: dateIst, exchange, instrumentKey } = fill;
    return [
      {
        allocationKey,
        dateIst,
        exchange,
        instrumentKey,
        component: charge.component,
        amountMicro: charge.amountMicro,
      },
    ];
  };
  return [
    ...charges.flatMap((charge) => place(charge, charge.allocationKey)),
    ...unattached.flatMap((charge) => place(charge, null)),
  ];
}

/** The allocation keys a position holds: its buys, matched sells and orphaned sells. */
export function memberKeys(position: Position): string[] {
  return [
    ...new Set([
      ...position.lots.flatMap((lot) => (lot.exit === null ? [lot.entry] : [lot.entry, lot.exit])),
      ...position.orphans.map((orphan) => orphan.allocation),
    ]),
  ];
}

export interface ReconcileContext {
  readonly broker: string;
  readonly fills: readonly ChargeableFill[];
  readonly allocations: readonly FillAllocation[];
  readonly allocationIds: ReadonlyMap<string, bigint>;
  readonly positions: readonly Position[];
  readonly charges: readonly FillCharge[];
  /** Charges of shares a corporate action cashed out (chargeAccount's `unattached`). */
  readonly unattached: readonly FillCharge[];
  readonly aliases: ReadonlyMap<string, string>;
}

const placeKey = (place: { dateIst: string; exchange: string; instrumentKey: string | null }): string =>
  JSON.stringify([place.dateIst, place.exchange, place.instrumentKey]);
const noteKey = (place: { dateIst: string; exchange: string }): string =>
  JSON.stringify([place.dateIst, place.exchange]);

/** The discrepancies that touch a position: its groups' own, and contract-note ones of the notes it traded in. */
function discrepanciesOf(
  keys: readonly string[],
  placed: ReadonlyMap<string, ChargedAllocation>,
  discrepancies: readonly ChargeDiscrepancy[],
): ChargeDiscrepancy[] {
  const groups = new Set<string>();
  const notes = new Set<string>();
  for (const key of keys) {
    const allocation = placed.get(key);
    if (allocation === undefined) continue;
    groups.add(placeKey(allocation));
    notes.add(noteKey(allocation));
  }
  return discrepancies.filter((entry) =>
    entry.instrumentKey === null ? notes.has(noteKey(entry)) : groups.has(placeKey(entry)),
  );
}

const NOTHING_RECONCILED: ReconcileResult = {
  reported: [],
  reportedUnattachedMicro: 0n,
  status: new Map(),
  discrepancies: [],
  unmatchedRows: [],
};

/**
 * Writes reported charges and every position's charge_reconciliation row; returns the `fee_discrepancy` findings
 * (positions beyond tolerance, statement rows matching no trade, unreadable statement rows). Only Dhan's Global
 * Transactions is a charge statement in v1; Zerodha positions stay estimated until a Tax P&L tolerance is verified
 * (PRD §16).
 */
export function reconcileAccount(
  db: Database.Database,
  accountId: string,
  context: ReconcileContext,
): Map<string, string> {
  const fills = new Map(context.fills.map((fill) => [fill.id, fill]));
  const placed = placeAllocations(fills, context.allocations);
  const statement =
    context.broker === 'dhan' ? chargeRows(db, accountId, context.aliases) : { rows: [], unreadable: 0 };
  const result =
    context.broker === 'dhan'
      ? reconcileCharges({
          allocations: [...placed.values()],
          estimated: placeEstimates(fills, context.charges, context.unattached),
          rows: statement.rows,
          coverage: coverageOf(db, accountId, ['dhan.global_transactions']),
        })
      : NOTHING_RECONCILED;
  writeReported(db, context.allocationIds, result.reported);
  const findings = writeStatuses(db, context.positions, placed, result);
  for (const row of result.unmatchedRows) {
    findings.set(
      `statement:${placeKey(row)}`,
      toJson({
        dateIst: row.dateIst,
        exchange: row.exchange,
        instrumentKey: row.instrumentKey,
        unmatchedStatementRow: true,
      }),
    );
  }
  if (statement.unreadable > 0)
    findings.set('statement:unreadable', toJson({ unreadableStatementRows: statement.unreadable }));
  return findings;
}

function writeReported(
  db: Database.Database,
  allocationIds: ReadonlyMap<string, bigint>,
  reported: ReconcileResult['reported'],
): void {
  const insert = db.prepare(
    `INSERT INTO fill_charge (fill_allocation_id, component, amount_micro, source, rule_version)
     VALUES (?, ?, ?, 'reported', NULL)`,
  );
  for (const charge of reported) {
    const id = allocationIds.get(charge.allocationKey);
    if (id === undefined) throw new Error('a reported charge references an unknown allocation');
    insert.run(id, charge.component, charge.amountMicro);
  }
}

/** Every position's status row; the positions in discrepancy as findings, keyed so two sharing an anchor stay apart. */
function writeStatuses(
  db: Database.Database,
  positions: readonly Position[],
  placed: ReadonlyMap<string, ChargedAllocation>,
  result: ReconcileResult,
): Map<string, string> {
  const insert = db.prepare(
    'INSERT INTO charge_reconciliation (position_id, status, diff_json) VALUES (?, ?, ?)',
  );
  const findings = new Map<string, string>();
  for (const position of positions) {
    const keys = memberKeys(position);
    const status = positionChargeStatus(keys, result.status);
    const diffs = status === 'FEES_DISCREPANCY' ? discrepanciesOf(keys, placed, result.discrepancies) : [];
    insert.run(position.id, status, toJson({ discrepancies: diffs }));
    if (status !== 'FEES_DISCREPANCY') continue;
    findings.set(
      `position:${JSON.stringify([position.anchorKey, position.instrumentKey, position.bucket])}`,
      toJson({ instrumentKey: position.instrumentKey, bucket: position.bucket, discrepancies: diffs }),
    );
  }
  return findings;
}

/**
 * Net charges for analytics (PRD §9.2): per allocation and component, the reported amount where a statement covers
 * it, otherwise the estimate. `fill_charge` keeps both rows, so summing it directly would count a charge twice.
 */
export const EFFECTIVE_CHARGES_SQL = `
  SELECT c.fill_allocation_id, c.component, c.amount_micro, c.source FROM fill_charge c
  WHERE c.source = 'reported' OR NOT EXISTS (
    SELECT 1 FROM fill_charge r
    WHERE r.fill_allocation_id = c.fill_allocation_id AND r.component = c.component AND r.source = 'reported')`;

/** Tax-report lots (Dhan Tax Report, Zerodha Tax P&L) with an ISIN; malformed rows are skipped. */
function statementLots(db: Database.Database, accountId: string): LotFacts[] {
  const rows = db
    .prepare(
      "SELECT key_json, data_json FROM statement_row WHERE account_id = ? AND kind IN ('dhan.tax.lot', 'zerodha.tax_pnl.lot')",
    )
    .all(accountId) as { key_json: string; data_json: string }[];
  return rows.flatMap((row): LotFacts[] => {
    const key = parseJson(row.key_json);
    const data = parseJson(row.data_json);
    const isin = text(key?.isin);
    const buy = text(key?.buy_date) ?? text(key?.entry_date);
    const sell = text(key?.sell_date) ?? text(key?.exit_date);
    const quantity = text(key?.quantity);
    const value = data?.buy_value_micro;
    if (isin === null || !ISIN.test(isin) || buy === null || sell === null) return [];
    if (quantity === null || !/^\d{1,18}$/.test(quantity) || typeof value !== 'string' || !MICRO.test(value))
      return [];
    return [
      { isin, buyDateIst: buy, sellDateIst: sell, quantity: BigInt(quantity), buyValueMicro: BigInt(value) },
    ];
  });
}

/** `fifo_mismatch` findings: the tax-report lots against our closed lots, inside each report's period. */
export function crossCheckAccount(
  db: Database.Database,
  accountId: string,
  positions: readonly Position[],
): Map<string, string> {
  const theirs = statementLots(db, accountId);
  if (theirs.length === 0) return new Map();
  const ours = positions.flatMap((position) =>
    position.lots.flatMap((lot): LotFacts[] =>
      lot.exitDateIst === null || !ISIN.test(position.instrumentKey)
        ? []
        : [
            {
              isin: position.instrumentKey,
              buyDateIst: lot.entryDateIst,
              sellDateIst: lot.exitDateIst,
              quantity: lot.quantity,
              buyValueMicro: lot.entryValueMicro,
            },
          ],
    ),
  );
  // A report's period is its import's coverage; failing that, the span of the lots it sold.
  const imported = coverageOf(db, accountId, ['dhan.tax_report', 'zerodha.tax_pnl']);
  const sells = theirs.map((lot) => lot.sellDateIst).sort();
  const coverage = imported.length > 0 ? imported : [{ from: sells[0] ?? '', to: sells.at(-1) ?? '' }];
  return new Map(
    crossCheckLots(ours, theirs, coverage).map((mismatch) => [
      [mismatch.isin, mismatch.buyDateIst, mismatch.sellDateIst].join('|'),
      toJson(mismatch),
    ]),
  );
}
