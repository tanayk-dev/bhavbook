// Corporate actions, stored (ADR-0015, PRD §7.4): entered by the user, revertible, applied by ISIN to every
// account (the table has no account: a split is a fact about the security). active <-> reverted.
// Inputs are validated twice: by schema here, and by core's rules before anything is stored. Stored rows are read
// back as untrusted data, and errors carry ids only, never stored content (ADR-0019). At most one active action
// holds the same facts. Does not recompute: callers use recompute/corporate-actions.ts.
import { randomBytes } from 'node:crypto';
import { reconstructAccount, type CorporateAction } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { isoDateSchema } from './adjustments.js';
import { ActionError, type ActionErrorCode } from './errors.js';

/** A corporate-action failure: its `code` is what the HTTP layer answers (`failed` is a 500). */
export class CorporateActionError extends ActionError {
  override readonly name: string = 'CorporateActionError';
  /** The stored action or the account involved, when there is one (ids only). */
  readonly corporateActionId: string | undefined;
  readonly accountId: string | undefined;

  constructor(
    message: string,
    ids: { corporateActionId?: string; accountId?: string } = {},
    code: ActionErrorCode = 'failed',
  ) {
    super(message, { code });
    this.corporateActionId = ids.corporateActionId;
    this.accountId = ids.accountId;
  }
}

const isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/);
/** Ratios are small whole numbers (1:5, 3:2); six digits is generous. */
const ratio = z.string().regex(/^[1-9]\d{0,5}$/);

/** What callers hold: bigints as decimal strings. */
export const corporateActionInputSchema = z
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

export type CorporateActionInput = z.infer<typeof corporateActionInputSchema>;

/** A stored row (better-sqlite3 reads integers as bigint); core checks the rest. */
const rowSchema = z.object({
  id: z.string(),
  type: z.enum(['SPLIT', 'BONUS', 'CONVERSION', 'DEMERGER']),
  isin: z.string(),
  new_isin: z.string().nullable(),
  ex_date: z.string(),
  allotment_date: z.string().nullable(),
  ratio_num: z.bigint(),
  ratio_den: z.bigint(),
  cost_split_bp: z.bigint().nullable(),
});

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

/** Core's rules for one action; true when it passes. */
function passesCore(action: CorporateAction): boolean {
  try {
    reconstructAccount([], [], [action]);
    return true;
  } catch {
    return false;
  }
}

/** A stored row as core's action; an unreadable one is a fixed error naming only its id. */
function fromRow(value: unknown, index: number): CorporateAction {
  const parsed = rowSchema.safeParse(value);
  const id = parsed.success ? parsed.data.id : `#${String(index)}`;
  // A conflict, not a fault: the user can revert the row (the list shows it as unreadable).
  const unreadable = new CorporateActionError(
    'a stored corporate action is unreadable',
    { corporateActionId: id },
    'conflict',
  );
  if (!parsed.success) throw unreadable;
  const row = parsed.data;
  const action: CorporateAction = {
    id: row.id,
    type: row.type,
    isin: row.isin,
    newIsin: row.new_isin,
    exDateIst: row.ex_date,
    allotmentDateIst: row.allotment_date,
    ratioNum: row.ratio_num,
    ratioDen: row.ratio_den,
    costSplitBp: row.cost_split_bp,
  };
  if (!passesCore(action)) throw unreadable;
  return action;
}

/**
 * Ids sort in creation order (actions on the same ex-date apply in id order): `ca_<creation time>_<random>`.
 * A preview uses PREVIEW_ID, which sorts after every stored id: as if created now.
 */
function newId(at: string): string {
  return `ca_${at.replace(/[^0-9]/g, '').slice(0, 17)}_${randomBytes(6).toString('hex')}`;
}
const PREVIEW_ID = 'ca_99999999999999999_preview';

/** A validated input as core's action (with the preview id until stored). */
export function parseCorporateAction(input: unknown, id = PREVIEW_ID): CorporateAction {
  const parsed = corporateActionInputSchema.safeParse(input);
  if (!parsed.success) throw new CorporateActionError('invalid corporate action', {}, 'invalid');
  const action = fromInput(id, parsed.data);
  if (!passesCore(action)) throw new CorporateActionError('invalid corporate action', {}, 'invalid');
  return action;
}

/** Same facts (everything but the id). */
export function sameFacts(a: CorporateAction, b: CorporateAction): boolean {
  const facts = (action: CorporateAction): string =>
    JSON.stringify({ ...action, id: '' }, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  return facts(a) === facts(b);
}

/** Every active action, in id (creation) order. */
export function activeCorporateActions(db: Database.Database): CorporateAction[] {
  const rows: unknown[] = db
    .prepare(`SELECT ${COLUMNS} FROM corporate_action WHERE status = 'active' ORDER BY id`)
    .all();
  return rows.map(fromRow);
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
  const at = (options.now?.() ?? new Date()).toISOString();
  const action = parseCorporateAction(input, newId(at));
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
  if (changed.changes !== 1) {
    throw new CorporateActionError(`no ${from} corporate action with that id`, {}, 'not_found');
  }
}

/** active -> reverted. Does not recompute. */
export function revertCorporateAction(db: Database.Database, id: string): void {
  transition(db, id, 'active', 'reverted');
}

/** reverted -> active, unless an identical action is already active. Does not recompute. */
export function restoreCorporateAction(db: Database.Database, id: string): void {
  db.transaction(() => {
    transition(db, id, 'reverted', 'active');
    const actions = activeCorporateActions(db);
    const restored = actions.find((action) => action.id === id);
    if (actions.some((other) => other.id !== id && restored !== undefined && sameFacts(other, restored))) {
      throw new CorporateActionError(
        'an identical corporate action is already active',
        { corporateActionId: id },
        'conflict',
      );
    }
  })();
}

export type StoredCorporateAction =
  | {
      readonly id: string;
      readonly action: CorporateAction;
      readonly status: Status;
      readonly createdAt: string;
    }
  /** A row core no longer accepts: listed by id only, so it can still be reverted. */
  | { readonly id: string; readonly action: null; readonly status: Status; readonly createdAt: string };

/** Every stored action, active and reverted, newest ex-date first (the corporate actions page). */
export function listCorporateActions(db: Database.Database): StoredCorporateAction[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS}, status, created_at FROM corporate_action ORDER BY ex_date DESC, id DESC`)
    .all() as (Record<string, unknown> & { id: string; status: Status; created_at: string })[];
  return rows.map((row, index) => {
    let action: CorporateAction | null;
    try {
      action = fromRow(row, index);
    } catch (error) {
      if (!(error instanceof CorporateActionError)) throw error;
      action = null;
    }
    return { id: row.id, action, status: row.status, createdAt: row.created_at };
  });
}
