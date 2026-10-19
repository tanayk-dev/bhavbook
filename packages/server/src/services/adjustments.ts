// Adjustments, stored (ADR-0013, PRD §5.5): user-confirmed and revertible, never edits to imported rows.
// active <-> reverted; active -> superseded (a later import covers the gap, or a newer override for the same day).
// Payloads are validated twice: by schema here, and by core's reconstruction rules before anything is stored.
// Stored payloads are read back as untrusted data. At most one product override is active per (instrument, day).
import { randomUUID } from 'node:crypto';
import { reconstructAccount, type Adjustment } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export class AdjustmentError extends Error {
  override readonly name = 'AdjustmentError';
}

export type AdjustmentSource = 'manual' | 'broker_statement';
export type AdjustmentStatus = 'active' | 'reverted' | 'superseded';

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const key = z.string().min(1).max(256);
const holding = z.enum(['DELIVERY', 'MTF']);
const bucket = z.enum(['DELIVERY', 'INTRADAY', 'MTF']);
/** Up to 999,999,999,999 shares and Rs 10^12: quantity x value products stay inside a signed 64-bit integer. */
export const quantitySchema = z.string().regex(/^[1-9]\d{0,11}$/);
export const microSchema = z.string().regex(/^\d{1,18}$/);

/** What callers (and the payload column) hold: bigints as decimal strings. */
const inputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('opening_lot'),
      instrumentKey: key,
      bucket: holding,
      quantity: quantitySchema,
      totalCostMicro: microSchema,
      entryDateIst: isoDateSchema.optional(),
      beforeDateIst: isoDateSchema.optional(),
      /** The broker-statement lot it came from (never offered again while this lot is active). */
      statementKey: key.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('exclude'), anchorKey: key }).strict(),
  z
    .object({ kind: z.literal('product_override'), instrumentKey: key, tradeDateIst: isoDateSchema, bucket })
    .strict(),
]);

export type AdjustmentInput = z.infer<typeof inputSchema>;

interface Row {
  readonly id: string;
  readonly account_id: string;
  readonly payload_json: string;
}

/** A stored payload as core's Adjustment (bigints restored). */
function toCore(id: string, accountId: string, input: AdjustmentInput): Adjustment {
  if (input.kind === 'opening_lot') {
    return {
      id,
      kind: 'opening_lot',
      accountId,
      instrumentKey: input.instrumentKey,
      bucket: input.bucket,
      quantity: BigInt(input.quantity),
      totalCostMicro: BigInt(input.totalCostMicro),
      entryDateIst: input.entryDateIst,
      beforeDateIst: input.beforeDateIst,
    };
  }
  if (input.kind === 'exclude') return { id, kind: 'exclude', accountId, anchorKey: input.anchorKey };
  return {
    id,
    kind: 'product_override',
    accountId,
    instrumentKey: input.instrumentKey,
    tradeDateIst: input.tradeDateIst,
    bucket: input.bucket,
  };
}

function parseInput(input: unknown): AdjustmentInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AdjustmentError('invalid adjustment');
  return parsed.data;
}

/** A stored row's payload; an unreadable one is a fixed error naming nothing from its content. */
function parseStored(row: Row): AdjustmentInput {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch (error) {
    throw new AdjustmentError('a stored adjustment is unreadable', {
      cause: { adjustmentId: row.id, error },
    });
  }
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success)
    throw new AdjustmentError('a stored adjustment is unreadable', { cause: { adjustmentId: row.id } });
  return parsed.data;
}

function accountExists(db: Database.Database, accountId: string): void {
  if (db.prepare('SELECT 1 FROM broker_account WHERE id = ?').get(accountId) === undefined) {
    throw new AdjustmentError('unknown account');
  }
}

/** Insertion order (rowid), so equal timestamps never reorder adjustments. */
function activeRows(db: Database.Database, accountId: string, type?: string): Row[] {
  return db
    .prepare(
      `SELECT id, account_id, payload_json FROM adjustment
       WHERE account_id = ? AND status = 'active' AND (? IS NULL OR type = ?) ORDER BY rowid`,
    )
    .all(accountId, type ?? null, type ?? null) as Row[];
}

/** Supersedes the other active overrides for the same (instrument, day) as `override`, by `byId`. */
function supersedeSameDay(
  db: Database.Database,
  accountId: string,
  override: AdjustmentInput,
  byId: string,
): void {
  if (override.kind !== 'product_override') return;
  const supersede = db.prepare("UPDATE adjustment SET status = 'superseded', superseded_by = ? WHERE id = ?");
  for (const other of activeRows(db, accountId, 'product_override')) {
    if (other.id === byId) continue;
    const payload = parseStored(other);
    if (
      payload.kind === 'product_override' &&
      payload.instrumentKey === override.instrumentKey &&
      payload.tradeDateIst === override.tradeDateIst
    ) {
      supersede.run(byId, other.id);
    }
  }
}

export interface CreateOptions {
  readonly source?: AdjustmentSource;
  readonly now?: () => Date;
}

/**
 * Stores a new active adjustment and returns its id; an identical active one (a double submit) is returned
 * instead of stored twice. A product override supersedes the active override for the same (instrument, day).
 * Does not recompute (the caller does).
 */
export function createAdjustment(
  db: Database.Database,
  accountId: string,
  input: unknown,
  options: CreateOptions = {},
): string {
  const adjustment = parseInput(input);
  const payload = JSON.stringify(adjustment);
  const id = `adj_${randomUUID()}`;
  try {
    reconstructAccount([], [toCore(id, accountId, adjustment)]);
  } catch (error) {
    throw new AdjustmentError('invalid adjustment', { cause: error });
  }
  const at = (options.now?.() ?? new Date()).toISOString();
  return db.transaction(() => {
    accountExists(db, accountId);
    const same = activeRows(db, accountId, adjustment.kind).find(
      (row) => JSON.stringify(parseStored(row)) === payload,
    );
    if (same !== undefined) return same.id;
    db.prepare(
      `INSERT INTO adjustment (id, account_id, type, payload_json, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(id, accountId, adjustment.kind, payload, options.source ?? 'manual', at);
    // After the insert: superseded_by references the new row.
    supersedeSameDay(db, accountId, adjustment, id);
    return id;
  })();
}

/** The account's active adjustments, as core reconstruction takes them. */
export function activeAdjustments(db: Database.Database, accountId: string): Adjustment[] {
  return activeRows(db, accountId).map((row) => toCore(row.id, row.account_id, parseStored(row)));
}

/** Statement lots already backing an active opening lot: never offered again. */
export function statementKeysInUse(db: Database.Database, accountId: string): Set<string> {
  const keys = activeRows(db, accountId, 'opening_lot').flatMap((row) => {
    const payload = parseStored(row);
    return payload.kind === 'opening_lot' && payload.statementKey !== undefined ? [payload.statementKey] : [];
  });
  return new Set(keys);
}

/** One atomic status change, optionally only within `accountId`. Returns the account id. */
function transition(
  db: Database.Database,
  id: string,
  from: AdjustmentStatus,
  to: AdjustmentStatus,
  accountId?: string,
): string {
  const account: unknown = db
    .prepare(
      'UPDATE adjustment SET status = ? WHERE id = ? AND status = ? AND (? IS NULL OR account_id = ?) RETURNING account_id',
    )
    .pluck()
    .get(to, id, from, accountId ?? null, accountId ?? null);
  if (typeof account !== 'string') throw new AdjustmentError(`no ${from} adjustment with that id`);
  return account;
}

/** active -> reverted. Returns the account id (to recompute). */
export function revertAdjustment(db: Database.Database, id: string): string {
  return transition(db, id, 'active', 'reverted');
}

/** reverted -> active; a restored override supersedes any newer one for the same day. */
export function restoreAdjustment(db: Database.Database, id: string): string {
  return db.transaction(() => {
    const accountId = transition(db, id, 'reverted', 'active');
    const row = db.prepare('SELECT id, account_id, payload_json FROM adjustment WHERE id = ?').get(id) as Row;
    supersedeSameDay(db, accountId, parseStored(row), id);
    return accountId;
  })();
}

/** active -> superseded within one account (E7: real fills now cover an opening lot; always the user's choice). */
export function supersedeAdjustment(db: Database.Database, id: string, accountId?: string): string {
  return transition(db, id, 'active', 'superseded', accountId);
}
