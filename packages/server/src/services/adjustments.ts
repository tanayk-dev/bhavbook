// Adjustments, stored (ADR-0013, PRD §5.5): user-confirmed and revertible, never edits to imported rows.
// active <-> reverted; active -> superseded (a later import covers the gap, or a newer override for the same day).
// Payloads are validated twice: by schema here, and by core's reconstruction rules before anything is stored.
import { randomUUID } from 'node:crypto';
import { reconstructAccount, type Adjustment } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export class AdjustmentError extends Error {
  override readonly name = 'AdjustmentError';
}

export type AdjustmentSource = 'manual' | 'broker_statement';
export type AdjustmentStatus = 'active' | 'reverted' | 'superseded';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const key = z.string().min(1).max(256);
const holding = z.enum(['DELIVERY', 'MTF']);
const bucket = z.enum(['DELIVERY', 'INTRADAY', 'MTF']);
const quantity = z.string().regex(/^[1-9]\d{0,14}$/);
const micro = z.string().regex(/^\d{1,20}$/);

/** What callers (and the payload column) hold: bigints as decimal strings. */
const inputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('opening_lot'),
      instrumentKey: key,
      bucket: holding,
      quantity,
      totalCostMicro: micro,
      entryDateIst: isoDate.optional(),
      beforeDateIst: isoDate.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('exclude'), anchorKey: key }).strict(),
  z
    .object({ kind: z.literal('product_override'), instrumentKey: key, tradeDateIst: isoDate, bucket })
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

function parse(input: unknown): AdjustmentInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AdjustmentError('invalid adjustment');
  return parsed.data;
}

function accountExists(db: Database.Database, accountId: string): void {
  if (db.prepare('SELECT 1 FROM broker_account WHERE id = ?').get(accountId) === undefined) {
    throw new AdjustmentError('unknown account');
  }
}

export interface CreateOptions {
  readonly source?: AdjustmentSource;
  readonly now?: () => Date;
}

/**
 * Stores a new active adjustment and returns its id. A product override supersedes the active override for the
 * same (instrument, day), so reconstruction never sees two. Does not recompute (the caller does).
 */
export function createAdjustment(
  db: Database.Database,
  accountId: string,
  input: unknown,
  options: CreateOptions = {},
): string {
  const adjustment = parse(input);
  const id = `adj_${randomUUID()}`;
  try {
    reconstructAccount([], [toCore(id, accountId, adjustment)]);
  } catch (error) {
    throw new AdjustmentError('invalid adjustment', { cause: error });
  }
  const at = (options.now?.() ?? new Date()).toISOString();
  db.transaction(() => {
    accountExists(db, accountId);
    // Older overrides for the same day, found before the new row exists, superseded after (superseded_by is a FK).
    const replaced =
      adjustment.kind === 'product_override'
        ? activeRows(db, accountId, 'product_override').filter((other) => {
            const payload = parse(JSON.parse(other.payload_json));
            return (
              payload.kind === 'product_override' &&
              payload.instrumentKey === adjustment.instrumentKey &&
              payload.tradeDateIst === adjustment.tradeDateIst
            );
          })
        : [];
    db.prepare(
      `INSERT INTO adjustment (id, account_id, type, payload_json, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(id, accountId, adjustment.kind, JSON.stringify(adjustment), options.source ?? 'manual', at);
    const supersede = db.prepare(
      "UPDATE adjustment SET status = 'superseded', superseded_by = ? WHERE id = ?",
    );
    for (const other of replaced) supersede.run(id, other.id);
  })();
  return id;
}

function activeRows(db: Database.Database, accountId: string, type?: string): Row[] {
  return db
    .prepare(
      `SELECT id, account_id, payload_json FROM adjustment
       WHERE account_id = ? AND status = 'active' AND (? IS NULL OR type = ?) ORDER BY created_at, id`,
    )
    .all(accountId, type ?? null, type ?? null) as Row[];
}

/** The account's active adjustments, as core reconstruction takes them. */
export function activeAdjustments(db: Database.Database, accountId: string): Adjustment[] {
  return activeRows(db, accountId).map((row) =>
    toCore(row.id, row.account_id, parse(JSON.parse(row.payload_json))),
  );
}

function transition(db: Database.Database, id: string, from: AdjustmentStatus, to: AdjustmentStatus): string {
  const row = db.prepare('SELECT account_id, status FROM adjustment WHERE id = ?').get(id) as
    { account_id: string; status: AdjustmentStatus } | undefined;
  if (row === undefined) throw new AdjustmentError('unknown adjustment');
  if (row.status !== from) throw new AdjustmentError(`the adjustment is not ${from}`);
  db.prepare('UPDATE adjustment SET status = ? WHERE id = ?').run(to, id);
  return row.account_id;
}

/** active -> reverted. Returns the account id (to recompute). */
export function revertAdjustment(db: Database.Database, id: string): string {
  return transition(db, id, 'active', 'reverted');
}

/** reverted -> active. */
export function restoreAdjustment(db: Database.Database, id: string): string {
  return transition(db, id, 'reverted', 'active');
}

/** active -> superseded (E7: real fills now cover an opening lot; always the user's choice). */
export function supersedeAdjustment(db: Database.Database, id: string): string {
  return transition(db, id, 'active', 'superseded');
}
