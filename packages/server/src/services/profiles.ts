// Profiles and broker accounts (PRD §4 onboarding, §2 C5). A profile groups the accounts one trading style is
// reviewed together; every profile belongs to a PAN entity (the tax owner, by label only: no PAN is ever stored,
// ADR-0019). Onboarding creates one default entity on the first profile. An account is a broker plus the user's
// nickname for it: there is deliberately no client-ID field (PRD §4).
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export class ProfileError extends Error {
  override readonly name = 'ProfileError';

  constructor(readonly code: 'invalid' | 'conflict' | 'not_found') {
    super(`profile request failed: ${code}`);
  }
}

/** Brokers with a v1 adapter (ADR-0006). */
export const SUPPORTED_BROKERS = ['zerodha', 'dhan'] as const;
export type SupportedBroker = (typeof SUPPORTED_BROKERS)[number];

const MAX_LABEL = 40;
const DEFAULT_ENTITY_LABEL = 'Default';

/** A user's label: trimmed, 1-40 characters, no control characters or line breaks. */
const label = z
  .string()
  .transform((text) => text.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(MAX_LABEL)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  );

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

/** Every profile with its accounts, oldest first. */
export function listProfiles(db: Database.Database): ProfileSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id AS profile_id, p.name AS profile_name, a.id AS account_id, a.broker, a.nickname
       FROM profile p LEFT JOIN broker_account a ON a.profile_id = p.id
       ORDER BY p.created_at, p.rowid, a.created_at, a.rowid`,
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

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ProfileError('invalid');
  return parsed.data;
}

function defaultEntity(db: Database.Database, at: string): string {
  const existing: unknown = db
    .prepare('SELECT id FROM pan_entity ORDER BY created_at, rowid LIMIT 1')
    .pluck()
    .get();
  if (typeof existing === 'string') return existing;
  const id = `pan_${randomUUID()}`;
  db.prepare('INSERT INTO pan_entity (id, label, created_at) VALUES (?, ?, ?)').run(
    id,
    DEFAULT_ENTITY_LABEL,
    at,
  );
  return id;
}

export interface CreateOptions {
  readonly now?: () => Date;
}

/** Creates a profile in the default PAN entity. Names are unique (case-insensitively) within an entity. */
export function createProfile(db: Database.Database, input: unknown, options: CreateOptions = {}): string {
  const { name } = parse(profileInputSchema, input);
  const at = (options.now?.() ?? new Date()).toISOString();
  return db.transaction(() => {
    const entity = defaultEntity(db, at);
    const taken = db
      .prepare('SELECT 1 FROM profile WHERE pan_entity_id = ? AND lower(name) = lower(?)')
      .get(entity, name);
    if (taken !== undefined) throw new ProfileError('conflict');
    const id = `prof_${randomUUID()}`;
    db.prepare('INSERT INTO profile (id, pan_entity_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      entity,
      name,
      at,
    );
    return id;
  })();
}

/** Adds a broker account to a profile. Nicknames are unique (case-insensitively) within a profile. */
export function createAccount(db: Database.Database, input: unknown, options: CreateOptions = {}): string {
  const { profileId, broker, nickname } = parse(accountInputSchema, input);
  const at = (options.now?.() ?? new Date()).toISOString();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM profile WHERE id = ?').get(profileId) === undefined) {
      throw new ProfileError('not_found');
    }
    const taken = db
      .prepare('SELECT 1 FROM broker_account WHERE profile_id = ? AND lower(nickname) = lower(?)')
      .get(profileId, nickname);
    if (taken !== undefined) throw new ProfileError('conflict');
    const id = `acc_${randomUUID()}`;
    db.prepare(
      'INSERT INTO broker_account (id, profile_id, broker, nickname, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, profileId, broker, nickname, at);
    return id;
  })();
}
