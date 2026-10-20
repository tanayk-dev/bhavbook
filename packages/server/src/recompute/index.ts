// Recompute (plan S9 task 5, ADR-0007): derived state is a pure function of the imported rows, the active
// adjustments and the active corporate actions. For one account: resolve instruments (S8), key every row (ISIN,
// else its alias, else a broker-local id), run the core pipeline with the adjustments (S10a) and corporate actions
// (S10b), and replace the account's allocations, positions and lots in one transaction. Issues are kept in step:
// INCOMPLETE positions, statement lots that could fill them, opening lots real fills now cover, suspected
// corporate actions, and fractions of a share (cash in lieu). Imported rows are never edited.
//
// Charges (S12a-2, ADR-0016): estimated from the bundled fee rules on the trades as imported, carried onto the
// allocations the rebuild ends with, and stored per allocation and component. Trades with no rule version in
// force are flagged by one `fees_unrated` issue.
import { createHash } from 'node:crypto';
import type { ParseResult } from '@bhavbook/adapters';
import {
  reconstructAccount,
  redundantOpeningLots,
  suggestOpeningLots,
  suspectCorporateActions,
  bundledFeeRules,
  chargeAccount,
  isFeeBroker,
  type AccountChargeResult,
  type Adjustment,
  type ChargeableFill,
  type FeeExchange,
  type FillCharge,
  type Bucket,
  type CorporateAction,
  type CorporateActionSuspicion,
  type Fraction,
  previewCorporateAction,
  type CorporateActionPreview,
  type FillAllocation,
  type Position,
  type StatementLot,
  type TradeFill,
} from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { writeBatches } from '../import/commit.js';
import type { PreviewCounts } from '../import/preview.js';
import { activeAdjustments, isoDateSchema, statementKeysInUse } from '../services/adjustments.js';
import {
  activeCorporateActions,
  CorporateActionError,
  parseCorporateAction,
  sameFacts,
} from '../services/corporate-actions.js';
import {
  mapInstrumentManually,
  resolveInstruments,
  type AliasRef,
  type ManualTarget,
} from '../services/instruments.js';
import {
  CASH_IN_LIEU,
  CORPORATE_ACTION_SUSPECTED,
  FEES_UNRATED,
  CHARGES_UNATTACHED,
  FILL_FROM_STATEMENT,
  INCOMPLETE_POSITION,
  JOURNAL_COLLISION,
  JOURNAL_UNATTACHED,
  OPENING_LOT_REDUNDANT,
  RECOMPUTE_FAILED,
  type IssueForecast,
} from './types.js';
import { attachJournal } from './journal.js';

export * from './types.js';

export interface RecomputeOptions {
  readonly now?: () => Date;
}

export interface RecomputeSummary {
  readonly positions: number;
  readonly open: number;
  readonly incomplete: number;
  readonly lots: number;
}

interface TradeRow {
  readonly id: bigint;
  readonly dedup_key: string;
  readonly granularity: 'fill' | 'order';
  readonly external_order_id: string | null;
  readonly executed_at_utc: string;
  readonly trade_date_ist: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: bigint;
  readonly trade_value_micro: bigint;
  readonly product_declared: Bucket | null;
  readonly isin: string | null;
  readonly broker_symbol: string | null;
  readonly broker_name: string | null;
  readonly exchange: FeeExchange;
}

/** The alias a broker's rows carry: Zerodha symbols, Dhan scrip names. */
function aliasOf(
  broker: string,
  row: { broker_symbol: string | null; broker_name: string | null },
): string | null {
  return (broker === 'zerodha' ? row.broker_symbol : row.broker_name) ?? row.broker_symbol ?? row.broker_name;
}

/** alias -> instrument key for a broker: the instrument's ISIN, or its id when it has none (manual). */
function aliasKeys(db: Database.Database, broker: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT a.alias, i.id, i.isin FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
       WHERE a.broker = ?`,
    )
    .all(broker) as { alias: string; id: string; isin: string | null }[];
  return new Map(rows.map((row) => [row.alias, row.isin ?? `ins:${row.id}`]));
}

/**
 * The FIFO key of a row (ADR-0011): ISIN, else the resolved alias, else a broker-local identity (PRD §5.4). A row
 * without any name gets a key of its own, so it can never match another instrument's rows.
 */
export function instrumentKeyOf(
  broker: string,
  row: { id: string; isin: string | null; broker_symbol: string | null; broker_name: string | null },
  aliases: ReadonlyMap<string, string>,
): string {
  if (row.isin !== null) return row.isin;
  const alias = aliasOf(broker, row);
  if (alias === null || alias === '') return `local:${broker}:#${row.id}`;
  return aliases.get(alias) ?? `local:${broker}:${alias}`;
}

function brokerOf(db: Database.Database, accountId: string): string {
  const broker: unknown = db.prepare('SELECT broker FROM broker_account WHERE id = ?').pluck().get(accountId);
  if (typeof broker !== 'string') throw new Error('unknown account');
  return broker;
}

function loadFills(db: Database.Database, accountId: string, broker: string): ChargeableFill[] {
  const aliases = aliasKeys(db, broker);
  // side, granularity, product_declared and exchange are enforced by CHECK constraints (0001_init.sql).
  const rows = db
    .prepare(
      `SELECT id, dedup_key, granularity, external_order_id, executed_at_utc, trade_date_ist, side, quantity,
              trade_value_micro, product_declared, isin, broker_symbol, broker_name, exchange
       FROM trade_row WHERE account_id = ?`,
    )
    .all(accountId) as TradeRow[];
  return rows.map((row) => ({
    id: String(row.id),
    accountId,
    instrumentKey: instrumentKeyOf(broker, { ...row, id: String(row.id) }, aliases),
    dedupKey: row.dedup_key,
    executedAtUtc: row.executed_at_utc,
    tradeDateIst: row.trade_date_ist,
    side: row.side,
    quantity: row.quantity,
    valueMicro: row.trade_value_micro,
    productDeclared: row.product_declared,
    exchange: row.exchange,
    granularity: row.granularity,
    externalOrderId: row.external_order_id,
  }));
}

/** Pure: what an account's fills, active adjustments and active corporate actions reconstruct to. */
export function reconstruct(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[] = [],
  corporateActions: readonly CorporateAction[] = [],
): {
  allocations: readonly FillAllocation[];
  positions: readonly Position[];
  fractions: readonly Fraction[];
} {
  return reconstructAccount(fills, adjustments, corporateActions);
}

/** Bonus and demerger-child lots (core gives them `ca:` fill ids); reshaped parts of real fills keep theirs. */
const CORPORATE_ACTION_FILL = 'ca:';

/** Where an allocation comes from: exactly one of a trade row, an adjustment or a corporate action. */
function sourceOf(allocation: FillAllocation): {
  tradeRowId: bigint | null;
  adjustmentId: string | null;
  corporateActionId: string | null;
} {
  if (allocation.adjustmentId !== null) {
    return { tradeRowId: null, adjustmentId: allocation.adjustmentId, corporateActionId: null };
  }
  if (allocation.corporateActionId !== null && allocation.fillId.startsWith(CORPORATE_ACTION_FILL)) {
    return { tradeRowId: null, adjustmentId: null, corporateActionId: allocation.corporateActionId };
  }
  return { tradeRowId: BigInt(allocation.fillId), adjustmentId: null, corporateActionId: null };
}

function sourceColumns(allocation: FillAllocation): [bigint | null, string | null, string | null] {
  const { tradeRowId, adjustmentId, corporateActionId } = sourceOf(allocation);
  return [tradeRowId, adjustmentId, corporateActionId];
}

/** Closed positions first (oldest close first), open ones last: the live position of an anchor is written last. */
function idOf(ids: ReadonlyMap<string, bigint>, key: string): bigint {
  const id = ids.get(key);
  if (id === undefined) throw new Error('lot references an unknown allocation');
  return id;
}

function writeDerived(
  db: Database.Database,
  accountId: string,
  allocations: readonly FillAllocation[],
  positions: readonly Position[],
): ReadonlyMap<string, bigint> {
  // Children go with their parents (lots, reconciliation, charges cascade); allocations last.
  db.prepare('DELETE FROM position WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM fill_allocation WHERE account_id = ?').run(accountId);
  const insertAllocation = db
    .prepare(
      `INSERT INTO fill_allocation (account_id, trade_row_id, adjustment_id, corporate_action_id, instrument_key,
         bucket, side, quantity, value_micro, inferred)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .pluck();
  const allocationIds = new Map<string, bigint>();
  for (const allocation of allocations) {
    const id: unknown = insertAllocation.get(
      accountId,
      ...sourceColumns(allocation),
      allocation.instrumentKey,
      allocation.bucket,
      allocation.side,
      allocation.quantity,
      allocation.valueMicro,
      allocation.inferred ? 1n : 0n,
    );
    if (typeof id !== 'bigint') throw new Error('fill_allocation insert returned no id');
    allocationIds.set(allocation.key, id);
  }
  const insertPosition = db.prepare(
    `INSERT INTO position (id, account_id, instrument_key, bucket, state, incomplete, excluded, orphan_qty,
       opened_at_utc, closed_at_utc, anchor_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLot = db.prepare(
    `INSERT INTO lot (position_id, entry_allocation_id, exit_allocation_id, quantity, entry_value_micro,
       exit_value_micro, entry_date_ist, exit_date_ist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const position of positions) {
    insertPosition.run(
      position.id,
      accountId,
      position.instrumentKey,
      position.bucket,
      position.state,
      position.incomplete ? 1n : 0n,
      position.excluded ? 1n : 0n,
      position.orphanQty,
      position.openedAtUtc,
      position.closedAtUtc,
      position.anchorKey,
    );
    for (const lot of position.lots) {
      insertLot.run(
        position.id,
        idOf(allocationIds, lot.entry),
        lot.exit === null ? null : idOf(allocationIds, lot.exit),
        lot.quantity,
        lot.entryValueMicro,
        lot.exitValueMicro,
        lot.entryDateIst,
        lot.exitDateIst,
      );
    }
  }
  return allocationIds;
}

/** Estimated charges; an account of a broker with no fee rules has every fill unrated. */
function chargesOf(
  broker: string,
  fills: readonly ChargeableFill[],
  adjustments: readonly Adjustment[],
  allocations: readonly FillAllocation[],
): AccountChargeResult {
  if (!isFeeBroker(broker)) return { charges: [], unrated: fills.map((fill) => fill.id), unattached: [] };
  return chargeAccount({ broker, fills, adjustments, allocations, rules: bundledFeeRules() });
}

/** One row per (allocation, component). Every charge chargeAccount attached has its allocation. */
function writeCharges(
  db: Database.Database,
  allocationIds: ReadonlyMap<string, bigint>,
  charges: readonly FillCharge[],
): void {
  const insert = db.prepare(
    `INSERT INTO fill_charge (fill_allocation_id, component, amount_micro, source, rule_version)
     VALUES (?, ?, ?, 'estimated', ?)`,
  );
  for (const charge of charges) {
    const id = allocationIds.get(charge.allocationKey);
    if (id === undefined) throw new Error('a charge references an unknown allocation');
    insert.run(id, charge.component, charge.amountMicro, charge.ruleVersion);
  }
}

/** Charges of shares a corporate action cashed out: no allocation left to hold them, so they are reported. */
function unattachedFindings(unattached: readonly FillCharge[]): Map<string, string> {
  const findings = new Map<string, string>();
  const total = unattached.reduce((sum, charge) => sum + charge.amountMicro, 0n);
  if (total > 0n)
    findings.set('charges', JSON.stringify({ totalMicro: total.toString(), charges: unattached.length }));
  return findings;
}

/** One issue while any trade has no fee rule version in force (charges unknown, never guessed). */
function unratedFindings(unrated: readonly string[]): Map<string, string> {
  const findings = new Map<string, string>();
  if (unrated.length > 0) findings.set('fees', JSON.stringify({ fills: unrated.length }));
  return findings;
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

interface IssueRow {
  readonly id: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly subject_json: string;
}

/**
 * Keeps one kind of issue in step with the current findings (fingerprint -> subject): new ones open, ones no
 * longer found are resolved, resolved ones found again re-open, and dismissed ones stay dismissed.
 */
function syncIssues(
  db: Database.Database,
  accountId: string,
  kind: string,
  current: ReadonlyMap<string, string>,
  at: string,
): void {
  const existing = db
    .prepare('SELECT id, fingerprint, status, subject_json FROM issue WHERE account_id = ? AND kind = ?')
    .all(accountId, kind) as IssueRow[];
  const known = new Map(existing.map((issue) => [issue.fingerprint, issue]));
  const insert = db.prepare(
    `INSERT INTO issue (id, account_id, kind, fingerprint, subject_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  );
  const reopen = db.prepare(
    "UPDATE issue SET status = 'open', subject_json = ?, resolved_at = NULL WHERE id = ?",
  );
  const refresh = db.prepare('UPDATE issue SET subject_json = ? WHERE id = ?');
  const resolve = db.prepare("UPDATE issue SET status = 'resolved', resolved_at = ? WHERE id = ?");
  for (const [fingerprint, subject] of current) {
    const issue = known.get(fingerprint);
    if (issue === undefined)
      insert.run(`iss_${digest(accountId, kind, fingerprint)}`, accountId, kind, fingerprint, subject, at);
    else if (issue.status === 'resolved') reopen.run(subject, issue.id);
    else if (issue.subject_json !== subject) refresh.run(subject, issue.id);
  }
  for (const issue of existing) {
    if (issue.status === 'open' && !current.has(issue.fingerprint)) resolve.run(at, issue.id);
  }
}

/** One per INCOMPLETE position, fingerprinted by its anchor (which survives re-keying). */
function incompleteFindings(positions: readonly Position[]): Map<string, string> {
  return new Map(
    positions
      .filter((position) => position.incomplete)
      .map((position) => [
        position.anchorKey,
        JSON.stringify({
          instrumentKey: position.instrumentKey,
          bucket: position.bucket,
          orphanQty: position.orphanQty.toString(),
          openedAtUtc: position.openedAtUtc,
        }),
      ]),
  );
}

const statementKeySchema = z.object({
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/),
  quantity: z.string().regex(/^[1-9]\d{0,11}$/),
  buy_date: isoDateSchema.optional(),
  entry_date: isoDateSchema.optional(),
  sell_date: isoDateSchema.optional(),
  exit_date: isoDateSchema.optional(),
});
const statementDataSchema = z.object({ buy_value_micro: z.string().regex(/^\d{1,18}$/) });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Broker-statement lots of the account (Dhan Tax Report, Zerodha Tax P&L); malformed rows are skipped. */
function statementLots(db: Database.Database, accountId: string, inUse: ReadonlySet<string>): StatementLot[] {
  const rows = db
    .prepare(
      "SELECT kind, dedup_key, key_json, data_json FROM statement_row WHERE account_id = ? AND kind IN ('dhan.tax.lot', 'zerodha.tax_pnl.lot')",
    )
    .all(accountId) as { kind: string; dedup_key: string; key_json: string; data_json: string }[];
  return rows.flatMap((row) => {
    const statementKey = `${row.kind}:${row.dedup_key}`;
    const key = statementKeySchema.safeParse(parseJson(row.key_json));
    const data = statementDataSchema.safeParse(parseJson(row.data_json));
    if (!key.success || !data.success || inUse.has(statementKey)) return [];
    const buyDate = key.data.buy_date ?? key.data.entry_date;
    if (buyDate === undefined) return [];
    return [
      {
        statementKey,
        isin: key.data.isin,
        quantity: BigInt(key.data.quantity),
        buyDateIst: buyDate,
        sellDateIst: key.data.sell_date ?? key.data.exit_date ?? null,
        buyValueMicro: BigInt(data.data.buy_value_micro),
      },
    ];
  });
}

/** INCOMPLETE positions a statement lot could fill: "Fill from broker statement" (ADR-0013). */
function statementFindings(
  db: Database.Database,
  accountId: string,
  positions: readonly Position[],
): Map<string, string> {
  // One suggestion per orphan sell (a run of orphan sells needs one lot each), keyed by position anchor and sell time.
  const orphans = positions.flatMap((position) =>
    position.incomplete
      ? position.orphans.map((orphan) => ({
          anchorKey: `${position.anchorKey}@${orphan.atUtc}`,
          instrumentKey: position.instrumentKey,
          bucket: position.bucket,
          quantity: orphan.quantity,
          dateIst: orphan.dateIst,
        }))
      : [],
  );
  if (orphans.length === 0) return new Map();
  const suggestions = suggestOpeningLots(
    orphans,
    statementLots(db, accountId, statementKeysInUse(db, accountId)),
  );
  return new Map(
    suggestions.map((suggestion) => [
      suggestion.anchorKey,
      JSON.stringify({
        instrumentKey: suggestion.instrumentKey,
        bucket: suggestion.bucket,
        quantity: suggestion.quantity.toString(),
        totalCostMicro: suggestion.totalCostMicro.toString(),
        entryDateIst: suggestion.entryDateIst,
        statementKey: suggestion.statementKey,
      }),
    ]),
  );
}

/** Opening lots that real fills now cover (E7): offered for replacement, never replaced automatically. */
function redundantFindings(
  fills: readonly TradeFill[],
  adjustments: readonly Adjustment[],
  corporateActions: readonly CorporateAction[],
): Map<string, string> {
  if (!adjustments.some((adjustment) => adjustment.kind === 'opening_lot')) return new Map();
  return new Map(
    redundantOpeningLots(fills, adjustments, corporateActions).map((id) => [
      id,
      JSON.stringify({ adjustmentId: id }),
    ]),
  );
}

function subjectOf(suspicion: CorporateActionSuspicion): string {
  if (suspicion.kind === 'split_or_bonus') {
    const { kind, instrumentKey, dateIst, multiple } = suspicion;
    return JSON.stringify({ kind, instrumentKey, dateIst, multiple: multiple.toString() });
  }
  const { kind, fromInstrument, toInstrument, dateIst } = suspicion;
  return JSON.stringify({ kind, fromInstrument, toInstrument, dateIst });
}

/** Patterns that suggest a corporate action the user hasn't entered (suggestions only, ADR-0015). */
function suspicionFindings(
  reconstruction: Parameters<typeof suspectCorporateActions>[0],
): Map<string, string> {
  return new Map(
    suspectCorporateActions(reconstruction).map((suspicion) => {
      const subject = subjectOf(suspicion);
      return [digest(subject), subject];
    }),
  );
}

/** Fractions of a share a corporate action left (the broker pays cash in lieu; the user may record the sale). */
function fractionFindings(fractions: readonly Fraction[]): Map<string, string> {
  return new Map(
    fractions.map((fraction) => [
      digest(fraction.actionId, fraction.instrumentKey, fraction.bucket),
      JSON.stringify({
        actionId: fraction.actionId,
        instrumentKey: fraction.instrumentKey,
        bucket: fraction.bucket,
        numerator: fraction.numerator.toString(),
        denominator: fraction.denominator.toString(),
        costRemovedMicro: fraction.costRemovedMicro.toString(),
      }),
    ]),
  );
}

function timestamp(options: RecomputeOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

/** Rebuilds an account's derived state; idempotent, one transaction. Clears a recorded recompute failure. */
export function recompute(
  db: Database.Database,
  accountId: string,
  options: RecomputeOptions = {},
): RecomputeSummary {
  const at = timestamp(options);
  return db.transaction(() => {
    const broker = brokerOf(db, accountId);
    resolveInstruments(db, accountId, { now: () => new Date(at) });
    const fills = loadFills(db, accountId, broker);
    const adjustments = activeAdjustments(db, accountId);
    const corporateActions = activeCorporateActions(db);
    const reconstruction = reconstruct(fills, adjustments, corporateActions);
    const { allocations, positions } = reconstruction;
    const allocationIds = writeDerived(db, accountId, allocations, positions);
    const { charges, unrated, unattached } = chargesOf(broker, fills, adjustments, allocations);
    writeCharges(db, allocationIds, charges);
    const journal = attachJournal(db, accountId, allocations, positions);
    syncIssues(db, accountId, JOURNAL_UNATTACHED, journal.unattached, at);
    syncIssues(db, accountId, JOURNAL_COLLISION, journal.collisions, at);
    syncIssues(db, accountId, FEES_UNRATED, unratedFindings(unrated), at);
    syncIssues(db, accountId, CHARGES_UNATTACHED, unattachedFindings(unattached), at);
    syncIssues(db, accountId, INCOMPLETE_POSITION, incompleteFindings(positions), at);
    syncIssues(db, accountId, FILL_FROM_STATEMENT, statementFindings(db, accountId, positions), at);
    syncIssues(
      db,
      accountId,
      OPENING_LOT_REDUNDANT,
      redundantFindings(fills, adjustments, corporateActions),
      at,
    );
    syncIssues(db, accountId, CORPORATE_ACTION_SUSPECTED, suspicionFindings(reconstruction), at);
    syncIssues(db, accountId, CASH_IN_LIEU, fractionFindings(reconstruction.fractions), at);
    db.prepare(
      "UPDATE issue SET status = 'resolved', resolved_at = ? WHERE account_id = ? AND kind = ? AND status = 'open'",
    ).run(at, accountId, RECOMPUTE_FAILED);
    return {
      positions: positions.length,
      open: positions.filter((position) => position.state === 'OPEN').length,
      incomplete: positions.filter((position) => position.incomplete).length,
      lots: positions.reduce((sum, position) => sum + position.lots.length, 0),
    };
  })();
}

function recordFailure(db: Database.Database, accountId: string, error: unknown, at: string): void {
  // Ids only (ADR-0019): the stored action to revert, when one is unreadable.
  const corporateActionId = error instanceof CorporateActionError ? error.corporateActionId : undefined;
  const subject = JSON.stringify({
    error: error instanceof Error ? error.name : 'non_error',
    corporateActionId,
  });
  db.prepare(
    `INSERT INTO issue (id, account_id, kind, fingerprint, subject_json, status, created_at)
     VALUES (?, ?, ?, 'recompute', ?, 'open', ?)
     ON CONFLICT (id) DO UPDATE SET status = 'open', subject_json = excluded.subject_json, resolved_at = NULL`,
  ).run(`iss_${digest(accountId, RECOMPUTE_FAILED)}`, accountId, RECOMPUTE_FAILED, subject, at);
}

/**
 * Aliases are per broker (S8), so a change for one account can re-key the others: recompute every account of the
 * broker. A failure is recorded as a `recompute_failed` issue (error name only, ADR-0019) instead of thrown, since
 * the data change that triggered it is already committed; the next successful recompute clears it.
 */
export function recomputeBroker(
  db: Database.Database,
  accountId: string,
  options: RecomputeOptions = {},
): void {
  const accounts = db
    .prepare(
      'SELECT id FROM broker_account WHERE broker = (SELECT broker FROM broker_account WHERE id = ?) ORDER BY id',
    )
    .pluck()
    .all(accountId) as string[];
  for (const account of accounts) {
    try {
      recompute(db, account, options);
    } catch (error) {
      recordFailure(db, account, error, timestamp(options));
    }
  }
}

/** A manual instrument mapping, then a recompute of every account that may use the alias. */
export function remapInstrument(
  db: Database.Database,
  accountId: string,
  ref: AliasRef,
  target: ManualTarget,
  options: RecomputeOptions = {},
): void {
  mapInstrumentManually(db, ref, target, { now: () => new Date(timestamp(options)) });
  recomputeBroker(db, accountId, options);
}

function incompleteSet(positions: readonly Position[]): Map<string, Position> {
  return new Map(
    positions.filter((position) => position.incomplete).map((position) => [position.anchorKey, position]),
  );
}

/** Thrown to roll the dry run back; never escapes forecastIssues. */
class DryRun extends Error {
  override readonly name = 'DryRun';
}

const EMPTY_COUNTS: PreviewCounts = {
  rows: { new: 0, duplicate: 0 },
  statements: { new: 0, duplicate: 0 },
  skipped: {},
  errors: 0,
};

/** Positions as a recompute would build them now (instrument resolution included). Call inside a transaction. */
function currentPositions(db: Database.Database, accountId: string, at: string): readonly Position[] {
  const broker = brokerOf(db, accountId);
  resolveInstruments(db, accountId, { now: () => new Date(at) });
  const fills = loadFills(db, accountId, broker);
  return reconstruct(fills, activeAdjustments(db, accountId), activeCorporateActions(db)).positions;
}

/**
 * The preview's issue forecast (PRD §5.1): a dry-run recompute. The file's rows are written inside a savepoint,
 * instruments are resolved and positions rebuilt exactly as a commit would, and the savepoint is rolled back, so
 * nothing persists. Reports the INCOMPLETE positions the commit would create or resolve. Each file is forecast
 * against the vault on its own (not together with the other files of the same preview).
 */
export function forecastIssues(
  db: Database.Database,
  accountId: string,
  result: ParseResult,
  options: RecomputeOptions = {},
): IssueForecast[] {
  const at = timestamp(options);
  let before = new Map<string, Position>();
  let after = new Map<string, Position>();
  try {
    db.transaction(() => {
      before = incompleteSet(currentPositions(db, accountId, at));
      const file = {
        kind: 'forecast',
        adapterVersion: '',
        sha256: '0'.repeat(64),
        result,
        counts: EMPTY_COUNTS,
      };
      writeBatches(db, accountId, [file], at);
      after = incompleteSet(currentPositions(db, accountId, at));
      throw new DryRun();
    })();
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  const describe = (change: 'create' | 'resolve', position: Position): IssueForecast => ({
    kind: INCOMPLETE_POSITION,
    change,
    instrumentKey: position.instrumentKey,
    bucket: position.bucket,
    orphanQty: position.orphanQty.toString(),
  });
  return [
    ...[...after].filter(([key]) => !before.has(key)).map(([, position]) => describe('create', position)),
    ...[...before].filter(([key]) => !after.has(key)).map(([, position]) => describe('resolve', position)),
  ];
}

/** The import service's hooks: recompute after every change, and forecast issues in previews. */
export function recomputeHooks(
  db: Database.Database,
  options: RecomputeOptions = {},
): {
  onChanged: (accountId: string) => void;
  forecast: (accountId: string, result: ParseResult) => IssueForecast[];
} {
  return {
    onChanged: (accountId) => {
      recomputeBroker(db, accountId, options);
    },
    forecast: (accountId, result) => forecastIssues(db, accountId, result, options),
  };
}

/**
 * What a corporate action would do across the vault (PRD §7.4 preview), from the stored state: every account's
 * affected open lots before and after, and the fractions. An identical active action is left out (storing this
 * one would return it instead). Stores nothing.
 */
export function previewCorporateActionInVault(db: Database.Database, input: unknown): CorporateActionPreview {
  const action = parseCorporateAction(input);
  const existing = activeCorporateActions(db).filter((other) => !sameFacts(other, action));
  const accounts = db.prepare('SELECT id, broker FROM broker_account ORDER BY id').all() as {
    id: string;
    broker: string;
  }[];
  const previews = accounts.map((account) =>
    previewCorporateAction(
      loadFills(db, account.id, account.broker),
      activeAdjustments(db, account.id),
      action,
      existing,
    ),
  );
  return {
    before: previews.flatMap((preview) => preview.before),
    after: previews.flatMap((preview) => preview.after),
    fractions: previews.flatMap((preview) => preview.fractions),
  };
}
