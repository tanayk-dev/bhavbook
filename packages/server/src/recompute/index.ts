// Recompute (plan S9 task 5, ADR-0007): derived state is a pure function of the imported rows. For one account:
// resolve instruments (S8), key every row (ISIN, else its alias, else a broker-local id), run the core pipeline,
// and replace the account's allocations, positions and lots in one transaction. INCOMPLETE positions are kept in
// step with `incomplete_position` issues. Imported rows are never edited.
//
// Scope today: trade-row allocations only. Adjustment and corporate-action allocations (S10a/S10b), user
// exclusions (`position.excluded`, S10a) and charges (S12a) are added by those steps and must be rebuilt here too.
import { createHash } from 'node:crypto';
import type { ParseResult } from '@bhavbook/adapters';
import {
  allocateBuckets,
  buildPositions,
  matchFifo,
  type Bucket,
  type FillAllocation,
  type Position,
  type TradeFill,
} from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { writeBatches } from '../import/commit.js';
import type { PreviewCounts } from '../import/preview.js';
import {
  mapInstrumentManually,
  resolveInstruments,
  type AliasRef,
  type ManualTarget,
} from '../services/instruments.js';
import { INCOMPLETE_POSITION, RECOMPUTE_FAILED, type IssueForecast } from './types.js';

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

function loadFills(db: Database.Database, accountId: string, broker: string): TradeFill[] {
  const aliases = aliasKeys(db, broker);
  // side, granularity and product_declared are enforced by CHECK constraints (0001_init.sql).
  const rows = db
    .prepare(
      `SELECT id, dedup_key, granularity, external_order_id, executed_at_utc, trade_date_ist, side, quantity,
              trade_value_micro, product_declared, isin, broker_symbol, broker_name
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
    granularity: row.granularity,
    externalOrderId: row.external_order_id,
  }));
}

/** Pure: the positions an account's fills reconstruct to (no product overrides until S10a). */
export function reconstruct(fills: readonly TradeFill[]): {
  allocations: FillAllocation[];
  positions: Position[];
} {
  const allocations = allocateBuckets(fills, []);
  return { allocations, positions: buildPositions(allocations, matchFifo(allocations)) };
}

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
): void {
  // Children go with their parents (lots, reconciliation, charges cascade); allocations last.
  db.prepare('DELETE FROM position WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM fill_allocation WHERE account_id = ? AND trade_row_id IS NOT NULL').run(accountId);
  const insertAllocation = db
    .prepare(
      `INSERT INTO fill_allocation (account_id, trade_row_id, instrument_key, bucket, side, quantity, value_micro,
         inferred)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .pluck();
  const allocationIds = new Map<string, bigint>();
  for (const allocation of allocations) {
    const id: unknown = insertAllocation.get(
      accountId,
      BigInt(allocation.fillId),
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
    `INSERT INTO position (id, account_id, instrument_key, bucket, state, incomplete, orphan_qty, opened_at_utc,
       closed_at_utc, anchor_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLot = db.prepare(
    `INSERT INTO lot (position_id, entry_allocation_id, exit_allocation_id, quantity, entry_value_micro,
       exit_value_micro, entry_date_ist, exit_date_ist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Journal entries follow their position across a re-key (migration 0001: anchor_instrument_key is refreshed).
  const refreshAnchor = db.prepare(
    'UPDATE journal_entry SET anchor_instrument_key = ? WHERE anchor_account_id = ? AND anchor_key = ?',
  );
  for (const position of positions) {
    insertPosition.run(
      position.id,
      accountId,
      position.instrumentKey,
      position.bucket,
      position.state,
      position.incomplete ? 1n : 0n,
      position.orphanQty,
      position.openedAtUtc,
      position.closedAtUtc,
      position.anchorKey,
    );
    refreshAnchor.run(position.instrumentKey, accountId, position.anchorKey);
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
 * One open issue per INCOMPLETE position, fingerprinted by the position's anchor (opening fill + bucket), which
 * survives re-keying; issues of positions no longer incomplete are resolved; dismissed ones stay dismissed.
 */
function syncIncompleteIssues(
  db: Database.Database,
  accountId: string,
  positions: readonly Position[],
  at: string,
): void {
  const current = new Map(
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
  const existing = db
    .prepare('SELECT id, fingerprint, status, subject_json FROM issue WHERE account_id = ? AND kind = ?')
    .all(accountId, INCOMPLETE_POSITION) as IssueRow[];
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
    if (issue === undefined) {
      insert.run(
        `iss_${digest(accountId, INCOMPLETE_POSITION, fingerprint)}`,
        accountId,
        INCOMPLETE_POSITION,
        fingerprint,
        subject,
        at,
      );
    } else if (issue.status === 'resolved') {
      reopen.run(subject, issue.id);
    } else if (issue.subject_json !== subject) {
      refresh.run(subject, issue.id);
    }
  }
  for (const issue of existing) {
    if (issue.status === 'open' && !current.has(issue.fingerprint)) resolve.run(at, issue.id);
  }
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
    const { allocations, positions } = reconstruct(loadFills(db, accountId, broker));
    writeDerived(db, accountId, allocations, positions);
    syncIncompleteIssues(db, accountId, positions, at);
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
  const subject = JSON.stringify({ error: error instanceof Error ? error.name : 'non_error' });
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
function currentPositions(db: Database.Database, accountId: string, at: string): Position[] {
  const broker = brokerOf(db, accountId);
  resolveInstruments(db, accountId, { now: () => new Date(at) });
  return reconstruct(loadFills(db, accountId, broker)).positions;
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
