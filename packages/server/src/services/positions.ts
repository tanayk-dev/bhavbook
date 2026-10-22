// Positions for the review queue and the position detail (PRD §4, §5.2, §5.3; plan S14a). Positions are derived and
// rebuilt by every recompute, but their id is deterministic (account | instrument | bucket | anchor), so a position's
// reference (its id in base64url) survives recomputes as long as its opening fill does. Money stays bigint; the HTTP
// layer sends it as decimal strings.
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { EFFECTIVE_CHARGES_SQL } from '../recompute/reconcile.js';
import { ActionError } from './errors.js';
import { instrumentNames } from './issues.js';

export const MAX_POSITIONS = 500;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A position's reference in URLs: its id in base64url (ids contain `|`, `#` and `:`). */
export const positionRef = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

export const positionRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);

export function positionIdOf(ref: string): string {
  return Buffer.from(ref, 'base64url').toString('utf8');
}

export const positionsFilterSchema = z
  .object({
    profileId: z.string().regex(ID).optional(),
    accountId: z.string().regex(ID).optional(),
    state: z.enum(['OPEN', 'CLOSED']).optional(),
    /** `unreviewed` is the review queue: closed, complete, not excluded, no reviewed journal entry. */
    review: z.enum(['unreviewed', 'reviewed']).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_POSITIONS).default(200),
  })
  .strict();

export type PositionsFilter = z.input<typeof positionsFilterSchema>;

export interface PositionSummary {
  readonly ref: string;
  readonly accountId: string;
  readonly accountNickname: string;
  readonly broker: string;
  readonly instrumentKey: string;
  readonly bucket: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly incomplete: boolean;
  readonly excluded: boolean;
  readonly orphanQty: bigint;
  readonly openedAtUtc: string;
  readonly closedAtUtc: string | null;
  /** Shares still held. */
  readonly openQty: bigint;
  readonly boughtQty: bigint;
  readonly boughtValueMicro: bigint;
  readonly soldValueMicro: bigint;
  /** Exit minus entry value of the closed lots, before charges. */
  readonly realisedGrossMicro: bigint;
  /** Effective charges of the position's fills: reported where a statement covers them, else estimated. */
  readonly chargesMicro: bigint;
  readonly feeStatus: string | null;
  readonly reviewedAt: string | null;
  readonly journalEntries: number;
}

interface SummaryRow {
  readonly id: string;
  readonly account_id: string;
  readonly nickname: string;
  readonly broker: string;
  readonly instrument_key: string;
  readonly bucket: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly incomplete: bigint;
  readonly excluded: bigint;
  readonly orphan_qty: bigint;
  readonly opened_at_utc: string;
  readonly closed_at_utc: string | null;
  readonly open_qty: bigint | null;
  readonly bought_qty: bigint | null;
  readonly bought_value: bigint | null;
  readonly sold_value: bigint | null;
  readonly realised: bigint | null;
  readonly charges: bigint | null;
  readonly fee_status: string | null;
  readonly reviewed_at: string | null;
  readonly entries: bigint | null;
}

// Each allocation belongs to one position (a run never splits a fill), so its charges count once, there.
const SUMMARY_SQL = `
  WITH members AS (
    SELECT position_id, entry_allocation_id AS allocation_id FROM lot
    UNION SELECT position_id, exit_allocation_id FROM lot WHERE exit_allocation_id IS NOT NULL),
  charges AS (
    SELECT m.position_id, sum(c.amount_micro) AS charges FROM members m
    JOIN (${EFFECTIVE_CHARGES_SQL}) c ON c.fill_allocation_id = m.allocation_id GROUP BY m.position_id),
  lots AS (
    SELECT position_id,
      sum(CASE WHEN exit_allocation_id IS NULL THEN quantity ELSE 0 END) AS open_qty,
      sum(quantity) AS bought_qty,
      sum(entry_value_micro) AS bought_value,
      sum(coalesce(exit_value_micro, 0)) AS sold_value,
      sum(CASE WHEN exit_value_micro IS NULL THEN 0 ELSE exit_value_micro - entry_value_micro END) AS realised
    FROM lot GROUP BY position_id),
  journal AS (
    SELECT a.position_id, max(e.reviewed_at) AS reviewed_at, count(*) AS entries
    FROM journal_attachment a JOIN journal_entry e ON e.id = a.journal_entry_id GROUP BY a.position_id)
  SELECT p.id, p.account_id, b.nickname, b.broker, p.instrument_key, p.bucket, p.state, p.incomplete, p.excluded,
    p.orphan_qty, p.opened_at_utc, p.closed_at_utc, l.open_qty, l.bought_qty, l.bought_value, l.sold_value,
    l.realised, c.charges, r.status AS fee_status, j.reviewed_at, j.entries
  FROM position p
  JOIN broker_account b ON b.id = p.account_id
  LEFT JOIN lots l ON l.position_id = p.id
  LEFT JOIN charges c ON c.position_id = p.id
  LEFT JOIN charge_reconciliation r ON r.position_id = p.id
  LEFT JOIN journal j ON j.position_id = p.id`;

function summaryOf(row: SummaryRow): PositionSummary {
  return {
    ref: positionRef(row.id),
    accountId: row.account_id,
    accountNickname: row.nickname,
    broker: row.broker,
    instrumentKey: row.instrument_key,
    bucket: row.bucket,
    state: row.state,
    incomplete: row.incomplete === 1n,
    excluded: row.excluded === 1n,
    orphanQty: row.orphan_qty,
    openedAtUtc: row.opened_at_utc,
    closedAtUtc: row.closed_at_utc,
    openQty: row.open_qty ?? 0n,
    boughtQty: row.bought_qty ?? 0n,
    boughtValueMicro: row.bought_value ?? 0n,
    soldValueMicro: row.sold_value ?? 0n,
    realisedGrossMicro: row.realised ?? 0n,
    chargesMicro: row.charges ?? 0n,
    feeStatus: row.fee_status,
    reviewedAt: row.reviewed_at,
    journalEntries: Number(row.entries ?? 0n),
  };
}

export interface PositionList {
  readonly positions: PositionSummary[];
  readonly total: number;
  /** Display names of the instruments listed, by instrument key. */
  readonly instruments: Record<string, string>;
}

const REVIEW_QUEUE = "p.state = 'CLOSED' AND p.incomplete = 0 AND p.excluded = 0 AND j.reviewed_at IS NULL";
const REVIEWED = "p.state = 'CLOSED' AND j.reviewed_at IS NOT NULL";

/** Positions, newest first (by when they closed, else opened): the review queue when `review` is `unreviewed`. */
export function listPositions(db: Database.Database, filter: PositionsFilter = {}): PositionList {
  const parsed = positionsFilterSchema.parse(filter);
  const conditions = [
    '(? IS NULL OR b.profile_id = ?)',
    '(? IS NULL OR p.account_id = ?)',
    '(? IS NULL OR p.state = ?)',
    ...(parsed.review === 'unreviewed' ? [REVIEW_QUEUE] : parsed.review === 'reviewed' ? [REVIEWED] : []),
  ];
  const args = [
    parsed.profileId ?? null,
    parsed.profileId ?? null,
    parsed.accountId ?? null,
    parsed.accountId ?? null,
    parsed.state ?? null,
    parsed.state ?? null,
  ];
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total: unknown = db
    .prepare(`SELECT count(*) FROM (${SUMMARY_SQL} ${where})`)
    .pluck()
    .get(...args);
  const rows = db
    .prepare(`${SUMMARY_SQL} ${where} ORDER BY coalesce(p.closed_at_utc, p.opened_at_utc) DESC, p.id LIMIT ?`)
    .all(...args, parsed.limit) as SummaryRow[];
  const positions = rows.map(summaryOf);
  return {
    positions,
    total: Number(total),
    instruments: instrumentNames(
      db,
      positions.map((position) => position.instrumentKey),
    ),
  };
}

/** Closed positions waiting for review, for the navigation counter. */
export function reviewQueueCount(db: Database.Database): number {
  const count: unknown = db
    .prepare(`SELECT count(*) FROM (${SUMMARY_SQL} WHERE ${REVIEW_QUEUE})`)
    .pluck()
    .get();
  return Number(count);
}

export interface PositionFill {
  readonly allocationId: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: bigint;
  /** The value this allocation carries (a fill split across buckets carries its share). */
  readonly valueMicro: bigint;
  /** The bucket BhavBook assigned. */
  readonly bucket: string;
  /** The bucket was inferred (Zerodha has no product column), not declared. */
  readonly inferred: boolean;
  readonly source: 'trade' | 'opening_lot' | 'corporate_action';
  /** Present for imported trades. */
  readonly trade: {
    readonly executedAtUtc: string;
    readonly tradeDateIst: string;
    readonly exchange: string;
    readonly quantity: bigint;
    readonly priceMicro: bigint;
    readonly tradeValueMicro: bigint;
    readonly valueAuthority: string;
    readonly productDeclared: string | null;
    /** The row as the broker's file had it. */
    readonly raw: string | null;
  } | null;
}

export interface PositionLot {
  readonly entryAllocationId: string;
  readonly exitAllocationId: string | null;
  readonly quantity: bigint;
  readonly entryValueMicro: bigint;
  readonly exitValueMicro: bigint | null;
  readonly entryDateIst: string;
  readonly exitDateIst: string | null;
}

export interface PositionCharge {
  readonly allocationId: string;
  readonly component: string;
  readonly source: 'estimated' | 'reported';
  readonly amountMicro: bigint;
  readonly ruleVersion: string | null;
}

export interface JournalEntryView {
  readonly id: string;
  readonly setupTagId: string | null;
  readonly mistakeTagIds: string[];
  readonly thesis: string | null;
  readonly initialStopMicro: bigint | null;
  readonly plannedStopMicro: bigint | null;
  readonly plannedTargetMicro: bigint | null;
  readonly plannedRiskMicro: bigint | null;
  readonly reviewNote: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attachments: { readonly id: string; readonly bytes: number; readonly createdAt: string }[];
}

export interface PositionDetail {
  readonly position: PositionSummary;
  readonly instruments: Record<string, string>;
  readonly fills: PositionFill[];
  readonly lots: PositionLot[];
  readonly charges: PositionCharge[];
  /** The discrepancies the statement showed (FEES_DISCREPANCY), as recorded by reconciliation. */
  readonly feeDiscrepancies: unknown[];
  readonly journal: JournalEntryView[];
}

/** One position by its reference; ActionError not_found when no position has it (now). */
export function positionById(db: Database.Database, id: string): PositionSummary {
  const row = db.prepare(`${SUMMARY_SQL} WHERE p.id = ?`).get(id) as SummaryRow | undefined;
  if (row === undefined) throw new ActionError('no such position', { code: 'not_found' });
  return summaryOf(row);
}

interface FillRow {
  readonly id: bigint;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: bigint;
  readonly value_micro: bigint;
  readonly bucket: string;
  readonly inferred: bigint;
  readonly trade_row_id: bigint | null;
  readonly adjustment_id: string | null;
  readonly executed_at_utc: string | null;
  readonly trade_date_ist: string | null;
  readonly exchange: string | null;
  readonly trade_quantity: bigint | null;
  readonly price_micro: bigint | null;
  readonly trade_value_micro: bigint | null;
  readonly value_authority: string | null;
  readonly product_declared: string | null;
  readonly raw_text: string | null;
}

function fillsOf(db: Database.Database, id: string): PositionFill[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.side, f.quantity, f.value_micro, f.bucket, f.inferred, f.trade_row_id, f.adjustment_id,
         t.executed_at_utc, t.trade_date_ist, t.exchange, t.quantity AS trade_quantity, t.price_micro,
         t.trade_value_micro, t.value_authority, t.product_declared, r.raw_text
       FROM fill_allocation f
       LEFT JOIN trade_row t ON t.id = f.trade_row_id
       LEFT JOIN raw_row r ON r.id = t.raw_row_id
       WHERE f.id IN (SELECT entry_allocation_id FROM lot WHERE position_id = ?
                      UNION SELECT exit_allocation_id FROM lot WHERE position_id = ?)
       ORDER BY coalesce(t.executed_at_utc, ''), f.id`,
    )
    .all(id, id) as FillRow[];
  return rows.map((row) => ({
    allocationId: row.id.toString(),
    side: row.side,
    quantity: row.quantity,
    valueMicro: row.value_micro,
    bucket: row.bucket,
    inferred: row.inferred === 1n,
    source:
      row.trade_row_id !== null ? 'trade' : row.adjustment_id !== null ? 'opening_lot' : 'corporate_action',
    trade:
      row.trade_row_id === null
        ? null
        : {
            executedAtUtc: row.executed_at_utc ?? '',
            tradeDateIst: row.trade_date_ist ?? '',
            exchange: row.exchange ?? '',
            quantity: row.trade_quantity ?? 0n,
            priceMicro: row.price_micro ?? 0n,
            tradeValueMicro: row.trade_value_micro ?? 0n,
            valueAuthority: row.value_authority ?? '',
            productDeclared: row.product_declared,
            raw: row.raw_text,
          },
  }));
}

function lotsOf(db: Database.Database, id: string): PositionLot[] {
  const rows = db
    .prepare(
      `SELECT entry_allocation_id, exit_allocation_id, quantity, entry_value_micro, exit_value_micro, entry_date_ist,
         exit_date_ist FROM lot WHERE position_id = ? ORDER BY entry_date_ist, id`,
    )
    .all(id) as {
    entry_allocation_id: bigint;
    exit_allocation_id: bigint | null;
    quantity: bigint;
    entry_value_micro: bigint;
    exit_value_micro: bigint | null;
    entry_date_ist: string;
    exit_date_ist: string | null;
  }[];
  return rows.map((row) => ({
    entryAllocationId: row.entry_allocation_id.toString(),
    exitAllocationId: row.exit_allocation_id?.toString() ?? null,
    quantity: row.quantity,
    entryValueMicro: row.entry_value_micro,
    exitValueMicro: row.exit_value_micro,
    entryDateIst: row.entry_date_ist,
    exitDateIst: row.exit_date_ist,
  }));
}

function chargesOf(db: Database.Database, fills: readonly PositionFill[]): PositionCharge[] {
  const read = db.prepare(
    `SELECT component, source, amount_micro, rule_version FROM fill_charge
     WHERE fill_allocation_id = ? ORDER BY component, source`,
  );
  return fills.flatMap((fill) =>
    (
      read.all(BigInt(fill.allocationId)) as {
        component: string;
        source: 'estimated' | 'reported';
        amount_micro: bigint;
        rule_version: string | null;
      }[]
    ).map((row) => ({
      allocationId: fill.allocationId,
      component: row.component,
      source: row.source,
      amountMicro: row.amount_micro,
      ruleVersion: row.rule_version,
    })),
  );
}

function discrepanciesOf(db: Database.Database, id: string): unknown[] {
  const json: unknown = db
    .prepare('SELECT diff_json FROM charge_reconciliation WHERE position_id = ?')
    .pluck()
    .get(id);
  if (typeof json !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(json);
    const list =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { discrepancies?: unknown }).discrepancies
        : null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

interface EntryRow {
  readonly id: string;
  readonly setup_tag_id: string | null;
  readonly thesis: string | null;
  readonly initial_stop_micro: bigint | null;
  readonly planned_stop_micro: bigint | null;
  readonly planned_target_micro: bigint | null;
  readonly planned_risk_micro: bigint | null;
  readonly review_note: string | null;
  readonly reviewed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The journal entries attached to a position, oldest first (two of them is a collision the inbox raises). */
export function journalOf(db: Database.Database, positionId: string): JournalEntryView[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.setup_tag_id, e.thesis, e.initial_stop_micro, e.planned_stop_micro, e.planned_target_micro,
         e.planned_risk_micro, e.review_note, e.reviewed_at, e.created_at, e.updated_at
       FROM journal_attachment a JOIN journal_entry e ON e.id = a.journal_entry_id
       WHERE a.position_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(positionId) as EntryRow[];
  const tags = db
    .prepare(
      `SELECT l.tag_id FROM journal_tag l JOIN tag t ON t.id = l.tag_id
       WHERE l.journal_entry_id = ? AND t.kind = 'mistake' ORDER BY lower(t.name), t.id`,
    )
    .pluck();
  const attachments = db.prepare(
    'SELECT id, length(data) AS bytes, created_at FROM attachment WHERE journal_entry_id = ? ORDER BY created_at, id',
  );
  return rows.map((row) => ({
    id: row.id,
    setupTagId: row.setup_tag_id,
    mistakeTagIds: tags.all(row.id) as string[],
    thesis: row.thesis,
    initialStopMicro: row.initial_stop_micro,
    plannedStopMicro: row.planned_stop_micro,
    plannedTargetMicro: row.planned_target_micro,
    plannedRiskMicro: row.planned_risk_micro,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: (attachments.all(row.id) as { id: string; bytes: bigint; created_at: string }[]).map(
      (attachment) => ({
        id: attachment.id,
        bytes: Number(attachment.bytes),
        createdAt: attachment.created_at,
      }),
    ),
  }));
}

/** Everything the position detail shows. */
export function positionDetail(db: Database.Database, ref: string): PositionDetail {
  const id = positionIdOf(ref);
  const position = positionById(db, id);
  const fills = fillsOf(db, id);
  return {
    position,
    instruments: instrumentNames(db, [position.instrumentKey]),
    fills,
    lots: lotsOf(db, id),
    charges: chargesOf(db, fills),
    feeDiscrepancies: discrepanciesOf(db, id),
    journal: journalOf(db, id),
  };
}
