// Profiles and broker accounts (PRD §4 onboarding, §2 C5). A profile groups the accounts one trading style is
// reviewed together; every profile belongs to a PAN entity (the tax owner, by label only: no PAN is ever stored,
// ADR-0019). Onboarding creates one default entity on the first profile. An account is a broker plus the user's
// nickname for it: there is deliberately no client-ID field (PRD §4), and a label shaped like a PAN or a broker
// client ID is refused, so one cannot be stored by mistake either.
//
// Labels are free text the user chooses, stored NFC-normalised. Uniqueness ignores case (Unicode-aware here; the
// migration 0003 indexes back it up for ASCII). Writes take the vault's write lock up front (IMMEDIATE), so two
// BhavBook processes on one vault cannot both pass the checks.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export type ProfileErrorCode = 'invalid' | 'identifier' | 'conflict' | 'not_found' | 'recompute_failed';

export class ProfileError extends Error {
  override readonly name = 'ProfileError';

  constructor(
    readonly code: ProfileErrorCode,
    options?: ErrorOptions,
  ) {
    super(`profile request failed: ${code}`, options);
  }
}

/** Brokers with a v1 adapter (ADR-0006). */
export const SUPPORTED_BROKERS = ['zerodha', 'dhan'] as const;
export type SupportedBroker = (typeof SUPPORTED_BROKERS)[number];

const MAX_LABEL = 40;
const DEFAULT_ENTITY_LABEL = 'Default';

/**
 * Characters a label may not contain: controls and format characters (bidi overrides, zero-width), line and
 * paragraph separators, spaces other than the ASCII space, private-use and unassigned code points, and the
 * fillers that render as blank (U+115F, U+1160, U+3164, U+FFA0, U+2800).
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}ᅟᅠㅤﾠ⠀]|(?! )\p{Zs}/u;
const VISIBLE = /[\p{L}\p{N}]/u;
/** A lone UTF-16 surrogate (from a JSON escape such as "\ud800"): not text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Shapes of identifiers a label must never hold: a PAN, a Zerodha-style client ID, a numeric client ID. */
const IDENTIFIER_SHAPES: readonly RegExp[] = [/^[A-Z]{5}\d{4}[A-Z]$/i, /^[A-Z]{2,3}\d{3,6}$/i, /^\d{6,16}$/];

/** NFC-normalised and trimmed; null when it is not an acceptable label. */
function cleanLabel(value: string): string | null {
  if (LONE_SURROGATE.test(value)) return null;
  const text = value.normalize('NFC').trim();
  if (text.length === 0 || text.length > MAX_LABEL || FORBIDDEN.test(text) || !VISIBLE.test(text))
    return null;
  return text;
}

export function looksLikeIdentifier(label: string): boolean {
  const compact = label.replace(/[\s-]/g, '');
  return IDENTIFIER_SHAPES.some((shape) => shape.test(compact));
}

/** A label as sent, bounded before it is cleaned. */
export const label = z.string().max(MAX_LABEL * 4);

export const profileInputSchema = z.object({ name: label }).strict();
export const accountInputSchema = z
  .object({ profileId: z.string().min(1).max(64), broker: z.enum(SUPPORTED_BROKERS), nickname: label })
  .strict();

export interface AccountSummary {
  readonly id: string;
  readonly broker: string;
  readonly nickname: string;
}

export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly accounts: readonly AccountSummary[];
}

interface Row {
  readonly profile_id: string;
  readonly profile_name: string;
  readonly account_id: string | null;
  readonly broker: string | null;
  readonly nickname: string | null;
}

/** Every profile with its accounts, in creation (insertion) order. */
export function listProfiles(db: Database.Database): ProfileSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id AS profile_id, p.name AS profile_name, a.id AS account_id, a.broker, a.nickname
       FROM profile p LEFT JOIN broker_account a ON a.profile_id = p.id
       ORDER BY p.rowid, a.rowid`,
    )
    .all() as Row[];
  const profiles = new Map<string, { id: string; name: string; accounts: AccountSummary[] }>();
  for (const row of rows) {
    const profile = profiles.get(row.profile_id) ?? {
      id: row.profile_id,
      name: row.profile_name,
      accounts: [],
    };
    profiles.set(row.profile_id, profile);
    if (row.account_id !== null && row.broker !== null && row.nickname !== null) {
      profile.accounts.push({ id: row.account_id, broker: row.broker, nickname: row.nickname });
    }
  }
  return [...profiles.values()];
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ProfileError('invalid');
  return parsed.data;
}

export function acceptLabel(value: string): string {
  const text = cleanLabel(value);
  if (text === null) throw new ProfileError('invalid');
  if (looksLikeIdentifier(text)) throw new ProfileError('identifier');
  return text;
}

/** Case-insensitive (Unicode) clash with any existing label. */
export function clashes(existing: readonly unknown[], text: string): boolean {
  const folded = text.toLocaleLowerCase('en-IN');
  return existing.some((other) => typeof other === 'string' && other.toLocaleLowerCase('en-IN') === folded);
}

function defaultEntity(db: Database.Database, at: string): string {
  const existing: unknown = db.prepare('SELECT id FROM pan_entity ORDER BY rowid LIMIT 1').pluck().get();
  if (typeof existing === 'string') return existing;
  const id = `pan_${randomUUID()}`;
  db.prepare('INSERT INTO pan_entity (id, label, created_at) VALUES (?, ?, ?)').run(
    id,
    DEFAULT_ENTITY_LABEL,
    at,
  );
  return id;
}

/** Runs a write under the vault's write lock; a unique-index violation is a conflict. */
export function write<T>(db: Database.Database, work: () => T): T {
  try {
    return db.transaction(work).immediate();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ProfileError('conflict');
    }
    throw error;
  }
}

export interface CreateOptions {
  readonly now?: () => Date;
}

/** Creates a profile in the default PAN entity. Names are unique (ignoring case) within an entity. */
export function createProfile(db: Database.Database, input: unknown, options: CreateOptions = {}): string {
  const name = acceptLabel(parse(profileInputSchema, input).name);
  const at = (options.now?.() ?? new Date()).toISOString();
  return write(db, () => {
    const entity = defaultEntity(db, at);
    const names = db.prepare('SELECT name FROM profile WHERE pan_entity_id = ?').pluck().all(entity);
    if (clashes(names, name)) throw new ProfileError('conflict');
    const id = `prof_${randomUUID()}`;
    db.prepare('INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      entity,
      name,
      at,
    );
    return id;
  });
}

/** Adds a broker account to a profile. Nicknames are unique (ignoring case) within a profile. */
export function createAccount(db: Database.Database, input: unknown, options: CreateOptions = {}): string {
  const parsed = parse(accountInputSchema, input);
  const nickname = acceptLabel(parsed.nickname);
  const at = (options.now?.() ?? new Date()).toISOString();
  return write(db, () => {
    if (db.prepare('SELECT 1 FROM profile WHERE id = ?').get(parsed.profileId) === undefined) {
      throw new ProfileError('not_found');
    }
    const nicknames = db
      .prepare('SELECT nickname FROM broker_account WHERE profile_id = ?')
      .pluck()
      .all(parsed.profileId);
    if (clashes(nicknames, nickname)) throw new ProfileError('conflict');
    const id = `acc_${randomUUID()}`;
    db.prepare(
      'INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, parsed.profileId, parsed.broker, nickname, at);
    return id;
  });
}

export const renameProfileSchema = z.object({ name: label }).strict();
export const renameAccountSchema = z.object({ nickname: label }).strict();
export const moveAccountSchema = z.object({ profileId: z.string().min(1).max(64) }).strict();

/** Renames a profile; the same rules as creating one. */
export function renameProfile(db: Database.Database, id: string, input: unknown): void {
  const name = acceptLabel(parse(renameProfileSchema, input).name);
  write(db, () => {
    const entity: unknown = db.prepare('SELECT pan_entity_id FROM profile WHERE id = ?').pluck().get(id);
    if (typeof entity !== 'string') throw new ProfileError('not_found');
    const others = db
      .prepare('SELECT name FROM profile WHERE pan_entity_id = ? AND id <> ?')
      .pluck()
      .all(entity, id);
    if (clashes(others, name)) throw new ProfileError('conflict');
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run(name, id);
  });
}

/** Renames an account; the same rules as adding one. */
export function renameAccount(db: Database.Database, id: string, input: unknown): void {
  const nickname = acceptLabel(parse(renameAccountSchema, input).nickname);
  write(db, () => {
    const profile: unknown = db.prepare('SELECT profile_id FROM broker_account WHERE id = ?').pluck().get(id);
    if (typeof profile !== 'string') throw new ProfileError('not_found');
    const others = db
      .prepare('SELECT nickname FROM broker_account WHERE profile_id = ? AND id <> ?')
      .pluck()
      .all(profile, id);
    if (clashes(others, nickname)) throw new ProfileError('conflict');
    db.prepare('UPDATE broker_account SET nickname = ? WHERE id = ?').run(nickname, id);
  });
}

interface AccountRow {
  readonly profile_id: string;
  readonly nickname: string;
  readonly pan_entity_id: string;
}

/**
 * Moves an account to another profile and rebuilds it (PRD §2 C5: an account belongs to exactly one profile), all
 * under the vault's write lock: if the recompute fails, nothing moves (`recompute_failed`). A move to the profile
 * it is already in does nothing and recomputes nothing (returns null). The nickname must be free in the target
 * profile, and both profiles must belong to the same PAN entity (tax buckets are per entity).
 */
export function moveAccount<T>(
  db: Database.Database,
  id: string,
  input: unknown,
  rebuild: (accountId: string) => T,
): T | null {
  const { profileId } = parse(moveAccountSchema, input);
  return write(db, () => {
    const account = db
      .prepare(
        `SELECT a.profile_id, a.nickname, p.pan_entity_id FROM broker_account a JOIN profile p ON p.id = a.profile_id
         WHERE a.id = ?`,
      )
      .get(id) as AccountRow | undefined;
    const target: unknown = db
      .prepare('SELECT pan_entity_id FROM profile WHERE id = ?')
      .pluck()
      .get(profileId);
    if (account === undefined || typeof target !== 'string') throw new ProfileError('not_found');
    if (account.profile_id === profileId) return null;
    if (target !== account.pan_entity_id) throw new ProfileError('invalid');
    const taken = db
      .prepare('SELECT nickname FROM broker_account WHERE profile_id = ?')
      .pluck()
      .all(profileId);
    if (clashes(taken, account.nickname)) throw new ProfileError('conflict');
    db.prepare('UPDATE broker_account SET profile_id = ? WHERE id = ?').run(profileId, id);
    try {
      return rebuild(id);
    } catch (cause) {
      throw new ProfileError('recompute_failed', { cause });
    }
  });
}
