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
  type FillAllocation,
  type FillCharge,
  type LotFacts,
  type Position,
  type ReconciledComponent,
  type StatementChargeRow,
} from '@bhavbook/core';
import type Database from 'better-sqlite3';

/** Global Transactions columns, by component (adapters/dhan/statements.ts). */
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
function chargeRows(db: Database.Database, accountId: string, aliases: ReadonlyMap<string, string>) {
  const rows = db
    .prepare("SELECT key_json, data_json FROM statement_row WHERE account_id = ? AND kind = 'dhan.gt.row'")
    .all(accountId) as { key_json: string; data_json: string }[];
  return rows.flatMap((row): StatementChargeRow[] => {
    const key = parseJson(row.key_json);
    const data = parseJson(row.data_json);
    const date = text(key?.date);
    const name = text(key?.name);
    if (date === null || name === null || data === null) return [];
    const amounts: Partial<Record<ReconciledComponent, bigint>> = {};
    for (const [component, field] of Object.entries(GT_FIELDS) as [ReconciledComponent, string][]) {
      const value = data[field];
      if (typeof value !== 'string' || !MICRO.test(value)) return [];
      amounts[component] = BigInt(value);
    }
    return [{ dateIst: date, instrumentKey: aliases.get(name) ?? `local:dhan:${name}`, amounts }];
  });
}

/** Allocations of imported fills, placed by the fill (opening lots and corporate-action lots carry no charges). */
function chargedAllocations(
  fills: readonly ChargeableFill[],
  allocations: readonly FillAllocation[],
): ChargedAllocation[] {
  const byId = new Map(fills.map((fill) => [fill.id, fill]));
  return allocations.flatMap((allocation) => {
    const fill = allocation.adjustmentId === null ? byId.get(allocation.fillId) : undefined;
    if (fill === undefined) return [];
    return [
      {
        allocationKey: allocation.key,
        dateIst: fill.tradeDateIst,
        instrumentKey: fill.instrumentKey,
        valueMicro: allocation.valueMicro,
      },
    ];
  });
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
  readonly aliases: ReadonlyMap<string, string>;
}

/** The discrepancies that touch a position: its (date, instrument) groups, and day-level ones on its dates. */
function discrepanciesOf(
  keys: readonly string[],
  placed: ReadonlyMap<string, ChargedAllocation>,
  discrepancies: readonly ChargeDiscrepancy[],
): ChargeDiscrepancy[] {
  const groups = new Set<string>();
  const dates = new Set<string>();
  for (const key of keys) {
    const allocation = placed.get(key);
    if (allocation === undefined) continue;
    groups.add(`${allocation.dateIst}|${allocation.instrumentKey}`);
    dates.add(allocation.dateIst);
  }
  return discrepancies.filter((entry) =>
    entry.instrumentKey === null
      ? dates.has(entry.dateIst)
      : groups.has(`${entry.dateIst}|${entry.instrumentKey}`),
  );
}

/**
 * Writes reported charges and every position's charge_reconciliation row; returns the `fee_discrepancy` findings
 * (positions beyond tolerance, and statement rows matching no trade). Only Dhan's Global Transactions is a charge
 * statement in v1; Zerodha positions stay estimated until a Tax P&L tolerance is verified (PRD §16).
 */
export function reconcileAccount(
  db: Database.Database,
  accountId: string,
  context: ReconcileContext,
): Map<string, string> {
  const placedList = chargedAllocations(context.fills, context.allocations);
  const result =
    context.broker === 'dhan'
      ? reconcileCharges({
          allocations: placedList,
          estimated: context.charges,
          rows: chargeRows(db, accountId, context.aliases),
          coverage: coverageOf(db, accountId, ['dhan.global_transactions']),
        })
      : { reported: [], status: new Map(), discrepancies: [], unmatchedRows: [] };
  const insertCharge = db.prepare(
    `INSERT INTO fill_charge (fill_allocation_id, component, amount_micro, source, rule_version)
     VALUES (?, ?, ?, 'reported', NULL)`,
  );
  for (const charge of result.reported) {
    const id = context.allocationIds.get(charge.allocationKey);
    if (id === undefined) throw new Error('a reported charge references an unknown allocation');
    insertCharge.run(id, charge.component, charge.amountMicro);
  }
  const placed = new Map(placedList.map((allocation) => [allocation.allocationKey, allocation]));
  const insertStatus = db.prepare(
    'INSERT INTO charge_reconciliation (position_id, status, diff_json) VALUES (?, ?, ?)',
  );
  const findings = new Map<string, string>();
  for (const position of context.positions) {
    const keys = memberKeys(position);
    const status = positionChargeStatus(keys, result.status);
    const diffs = status === 'FEES_DISCREPANCY' ? discrepanciesOf(keys, placed, result.discrepancies) : [];
    insertStatus.run(position.id, status, toJson({ discrepancies: diffs }));
    if (status === 'FEES_DISCREPANCY') {
      findings.set(
        `position:${position.anchorKey}`,
        toJson({ instrumentKey: position.instrumentKey, bucket: position.bucket, discrepancies: diffs }),
      );
    }
  }
  for (const row of result.unmatchedRows) {
    findings.set(
      `statement:${row.dateIst}|${row.instrumentKey ?? ''}`,
      toJson({ dateIst: row.dateIst, instrumentKey: row.instrumentKey, unmatchedStatementRow: true }),
    );
  }
  return findings;
}

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
