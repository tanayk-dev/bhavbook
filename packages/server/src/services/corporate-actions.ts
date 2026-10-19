// Corporate actions, stored (ADR-0015, PRD §7.4): entered by the user, revertible, applied by ISIN to every
// account (the table has no account: a split is a fact about the security). active <-> reverted.
// Inputs are validated twice: by schema here, and by core's rules before anything is stored. Stored rows are read
// back as untrusted data. Does not recompute (the callers in recompute/corporate-actions.ts do).
import { randomUUID } from 'node:crypto';
import { reconstructAccount, type CorporateAction } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { isoDateSchema } from './adjustments.js';

export class CorporateActionError extends Error {
  override readonly name = 'CorporateActionError';
}

const isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/);
/** Ratios are small whole numbers (1:5, 3:2); six digits is generous. */
const ratio = z.string().regex(/^[1-9]\d{0,5}$/);

/** What callers hold: bigints as decimal strings. */
const inputSchema = z
  .object({
    type: z.enum(['SPLIT', 'BONUS', 'CONVERSION', 'DEMERGER']),
    isin,
    newIsin: isin.optional(),
    exDateIst: isoDateSchema,
    allotmentDateIst: isoDateSchema.optional(),
    ratioNum: ratio,
    ratioDen: ratio,
    costSplitBp: z
      .string()
      .regex(/^\d{1,5}$/)
      .optional(),
  })
  .strict();

export type CorporateActionInput = z.infer<typeof inputSchema>;

interface Row {
  readonly id: string;
  readonly type: string;
  readonly isin: string;
  readonly new_isin: string | null;
  readonly ex_date: string;
  readonly allotment_date: string | null;
  readonly ratio_num: bigint;
  readonly ratio_den: bigint;
  readonly cost_split_bp: bigint | null;
}

const COLUMNS = 'id, type, isin, new_isin, ex_date, allotment_date, ratio_num, ratio_den, cost_split_bp';

function fromInput(id: string, input: CorporateActionInput): CorporateAction {
  return {
    id,
    type: input.type,
    isin: input.isin,
    newIsin: input.newIsin ?? null,
    exDateIst: input.exDateIst,
    allotmentDateIst: input.allotmentDateIst ?? null,
    ratioNum: BigInt(input.ratioNum),
    ratioDen: BigInt(input.ratioDen),
    costSplitBp: input.costSplitBp === undefined ? null : BigInt(input.costSplitBp),
  };
}

function fromRow(row: Row): CorporateAction {
  // Read as untrusted: core checks every field (the type cast is checked there).
  return {
    id: row.id,
    type: row.type as CorporateAction['type'],
    isin: row.isin,
    newIsin: row.new_isin,
    exDateIst: row.ex_date,
    allotmentDateIst: row.allotment_date,
    ratioNum: row.ratio_num,
    ratioDen: row.ratio_den,
    costSplitBp: row.cost_split_bp,
  };
}

/** Core's rules (one action, or a set: ids unique). */
function checkWithCore(actions: readonly CorporateAction[]): void {
  reconstructAccount([], [], actions);
}

/** A validated input as core's action (`id` is a placeholder until stored). */
export function parseCorporateAction(input: unknown, id = 'preview'): CorporateAction {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new CorporateActionError('invalid corporate action');
  const action = fromInput(id, parsed.data);
  try {
    checkWithCore([action]);
  } catch (error) {
    throw new CorporateActionError('invalid corporate action', { cause: error });
  }
  return action;
}

function sameFacts(a: CorporateAction, b: CorporateAction): boolean {
  const facts = (action: CorporateAction): string =>
    JSON.stringify({ ...action, id: '' }, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  return facts(a) === facts(b);
}

function activeRows(db: Database.Database): Row[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM corporate_action WHERE status = 'active' ORDER BY rowid`)
    .all() as Row[];
}

/** Every active action; an unreadable one is a fixed error naming nothing from its content. */
export function activeCorporateActions(db: Database.Database): CorporateAction[] {
  const actions = activeRows(db).map(fromRow);
  for (const action of actions) {
    try {
      checkWithCore([action]);
    } catch (error) {
      throw new CorporateActionError('a stored corporate action is unreadable', {
        cause: { corporateActionId: action.id, error },
      });
    }
  }
  return actions;
}

export interface CorporateActionCreateOptions {
  readonly now?: () => Date;
}

/**
 * Stores a new active corporate action and returns its id; an identical active one (a double submit) is
 * returned instead of stored twice.
 */
export function createCorporateAction(
  db: Database.Database,
  input: unknown,
  options: CorporateActionCreateOptions = {},
): string {
  const action = parseCorporateAction(input, `ca_${randomUUID()}`);
  const at = (options.now?.() ?? new Date()).toISOString();
  return db.transaction(() => {
    const same = activeCorporateActions(db).find((other) => sameFacts(other, action));
    if (same !== undefined) return same.id;
    db.prepare(
      `INSERT INTO corporate_action (${COLUMNS}, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      action.id,
      action.type,
      action.isin,
      action.newIsin,
      action.exDateIst,
      action.allotmentDateIst,
      action.ratioNum,
      action.ratioDen,
      action.costSplitBp,
      at,
    );
    return action.id;
  })();
}

type Status = 'active' | 'reverted';

/** One atomic status change. */
function transition(db: Database.Database, id: string, from: Status, to: Status): void {
  const changed = db
    .prepare('UPDATE corporate_action SET status = ? WHERE id = ? AND status = ?')
    .run(to, id, from);
  if (changed.changes !== 1) throw new CorporateActionError(`no ${from} corporate action with that id`);
}

export function revertCorporateAction(db: Database.Database, id: string): void {
  transition(db, id, 'active', 'reverted');
}

export function restoreCorporateAction(db: Database.Database, id: string): void {
  transition(db, id, 'reverted', 'active');
}
