// Instrument resolution, persisted (plan S8, ADR-0014). The matching is pure (core/instruments); this module reads
// an account's rows and statements, writes `instrument` / `instrument_alias`, and raises or resolves
// `unresolved_instrument` issues. Imported rows are never edited: the alias table is what recompute (S9) uses to
// key a row without an ISIN.
import { createHash, randomUUID } from 'node:crypto';
import {
  aggregateByDay,
  fillIsinsBySymbol,
  resolveAliases,
  suggestInstruments,
  type DayAggregate,
  type IsinHint,
  type UnresolvedAlias,
} from '@bhavbook/core';
import type Database from 'better-sqlite3';

export type AliasSource = 'learned' | 'join' | 'file' | 'manual';

/** A stronger source replaces a weaker one; nothing automatic ever replaces a manual mapping. */
const SOURCE_RANK: Readonly<Record<AliasSource, number>> = { learned: 0, join: 1, file: 2, manual: 3 };
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
export const UNRESOLVED_INSTRUMENT = 'unresolved_instrument';

export class InstrumentError extends Error {
  override readonly name = 'InstrumentError';
}

export interface ResolveOptions {
  readonly now?: () => Date;
}

export interface ResolveSummary {
  /** Aliases resolved by this run (including ones already known). */
  readonly resolved: number;
  readonly unresolved: readonly UnresolvedAlias[];
}

export interface AliasRef {
  readonly broker: string;
  readonly alias: string;
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

function timestamp(options: ResolveOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

/** The instrument for an ISIN (created on first sight, named by the first name seen). */
function instrumentFor(db: Database.Database, isin: string, displayName: string): string {
  const id = `ins_${isin}`;
  db.prepare('INSERT INTO instrument (id, isin, display_name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(
    id,
    isin,
    displayName,
  );
  return db.prepare('SELECT id FROM instrument WHERE isin = ?').pluck().get(isin) as string;
}

function upsertAlias(
  db: Database.Database,
  ref: AliasRef,
  instrumentId: string,
  source: AliasSource,
  at: string,
): void {
  const existing = db
    .prepare('SELECT source, instrument_id FROM instrument_alias WHERE broker = ? AND alias = ?')
    .get(ref.broker, ref.alias) as { source: AliasSource; instrument_id: string } | undefined;
  if (existing === undefined) {
    db.prepare(
      'INSERT INTO instrument_alias (id, broker, alias, instrument_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`ali_${digest(ref.broker, ref.alias)}`, ref.broker, ref.alias, instrumentId, source, at);
    return;
  }
  const stronger = SOURCE_RANK[source] > SOURCE_RANK[existing.source] || source === 'manual';
  if (stronger && (existing.instrument_id !== instrumentId || existing.source !== source)) {
    db.prepare(
      'UPDATE instrument_alias SET instrument_id = ?, source = ? WHERE broker = ? AND alias = ?',
    ).run(instrumentId, source, ref.broker, ref.alias);
  }
}

function raiseIssue(
  db: Database.Database,
  accountId: string,
  broker: string,
  entry: UnresolvedAlias,
  at: string,
): void {
  const fingerprint = `${broker}:${entry.alias}`;
  const subject = JSON.stringify({
    broker,
    alias: entry.alias,
    reason: entry.reason,
    candidates: entry.candidates,
  });
  const existing = db
    .prepare(
      'SELECT id, status, subject_json FROM issue WHERE account_id = ? AND kind = ? AND fingerprint = ?',
    )
    .get(accountId, UNRESOLVED_INSTRUMENT, fingerprint) as
    { id: string; status: string; subject_json: string } | undefined;
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO issue (id, account_id, kind, fingerprint, subject_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      `iss_${digest(accountId, UNRESOLVED_INSTRUMENT, fingerprint)}`,
      accountId,
      UNRESOLVED_INSTRUMENT,
      fingerprint,
      subject,
      at,
    );
    return;
  }
  // A dismissed issue stays dismissed; a resolved one re-opens only if the name is unresolved again.
  if (existing.status === 'dismissed') return;
  if (existing.status === 'resolved' || existing.subject_json !== subject) {
    db.prepare("UPDATE issue SET status = 'open', subject_json = ?, resolved_at = NULL WHERE id = ?").run(
      subject,
      existing.id,
    );
  }
}

function resolveIssue(db: Database.Database, broker: string, alias: string, at: string): void {
  db.prepare(
    "UPDATE issue SET status = 'resolved', resolved_at = ? WHERE kind = ? AND fingerprint = ? AND status = 'open'",
  ).run(at, UNRESOLVED_INSTRUMENT, `${broker}:${alias}`);
}

interface StatementKey {
  readonly date?: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly isin?: string;
}

function statements(
  db: Database.Database,
  accountId: string,
  kind: string,
): { key: StatementKey; data: Record<string, string | null> }[] {
  const rows = db
    .prepare('SELECT key_json, data_json FROM statement_row WHERE account_id = ? AND kind = ?')
    .all(accountId, kind) as { key_json: string; data_json: string }[];
  return rows.map((row) => ({
    key: JSON.parse(row.key_json) as StatementKey,
    data: JSON.parse(row.data_json) as Record<string, string | null>,
  }));
}

function hintsOf(db: Database.Database, accountId: string, kinds: readonly string[]): IsinHint[] {
  return kinds
    .flatMap((kind) => statements(db, accountId, kind))
    .flatMap(({ key }) => {
      const name = key.name ?? key.symbol ?? '';
      return name !== '' && ISIN.test(key.isin ?? '') ? [{ name, isin: key.isin ?? '' }] : [];
    });
}

const bigintOf = (text: string | null | undefined): bigint =>
  text != null && /^-?\d+$/.test(text) ? BigInt(text) : 0n;

function resolveDhan(db: Database.Database, accountId: string, at: string): ResolveSummary {
  const fills = db
    .prepare(
      `SELECT trade_date_ist AS date, broker_name AS name, side, quantity, trade_value_micro AS value
       FROM trade_row WHERE account_id = ? AND isin IS NULL AND broker_name IS NOT NULL`,
    )
    .all(accountId) as {
    date: string;
    name: string;
    side: 'BUY' | 'SELL';
    quantity: bigint;
    value: bigint;
  }[];
  const trades = aggregateByDay(fills.map((fill) => ({ ...fill, valueMicro: fill.value })));
  const gt: DayAggregate[] = statements(db, accountId, 'dhan.gt.row').map(({ key, data }) => ({
    date: key.date ?? '',
    name: key.name ?? '',
    buyQty: bigintOf(data.buy_qty),
    sellQty: bigintOf(data.sell_qty),
    buyValueMicro: bigintOf(data.buy_value_micro),
    sellValueMicro: bigintOf(data.sell_value_micro),
  }));
  const hints = hintsOf(db, accountId, ['dhan.dp.row', 'dhan.tax.lot']);
  const known = db
    .prepare(
      `SELECT a.alias, i.isin FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
       WHERE a.broker = 'dhan' AND i.isin IS NOT NULL`,
    )
    .all() as { alias: string; isin: string }[];
  const result = resolveAliases({ trades, statements: gt, hints, known });
  // Statement names are aliases too (their ISIN is in the file), so later files and manual mapping can use them.
  for (const hint of hints) {
    upsertAlias(
      db,
      { broker: 'dhan', alias: hint.name },
      instrumentFor(db, hint.isin, hint.name),
      'file',
      at,
    );
  }
  for (const entry of result.resolved) {
    const instrument = instrumentFor(db, entry.isin, entry.via ?? entry.alias);
    upsertAlias(db, { broker: 'dhan', alias: entry.alias }, instrument, entry.source, at);
    resolveIssue(db, 'dhan', entry.alias, at);
  }
  for (const entry of result.unresolved) raiseIssue(db, accountId, 'dhan', entry, at);
  return { resolved: result.resolved.length, unresolved: result.unresolved };
}

function resolveZerodha(db: Database.Database, accountId: string, at: string): ResolveSummary {
  const rows = db
    .prepare(
      'SELECT broker_symbol AS symbol, isin FROM trade_row WHERE account_id = ? AND broker_symbol IS NOT NULL',
    )
    .all(accountId) as { symbol: string; isin: string | null }[];
  const fromStatements = hintsOf(db, accountId, ['zerodha.tax_pnl.lot']).map((hint) => ({
    symbol: hint.name,
    isin: hint.isin,
  }));
  const filled = fillIsinsBySymbol([...rows, ...fromStatements]);
  const tradedSymbols = new Set(rows.map((row) => row.symbol));
  let resolved = 0;
  for (const { symbol, isin } of filled.bySymbol) {
    upsertAlias(db, { broker: 'zerodha', alias: symbol }, instrumentFor(db, isin, symbol), 'file', at);
    resolveIssue(db, 'zerodha', symbol, at);
    if (tradedSymbols.has(symbol)) resolved += 1;
  }
  const unresolved: UnresolvedAlias[] = [
    ...filled.conflicts.map((alias) => ({ alias, reason: 'ambiguous' as const, candidates: [] })),
    ...filled.missing.map((alias) => ({ alias, reason: 'no_evidence' as const, candidates: [] })),
  ].sort((a, b) => (a.alias < b.alias ? -1 : 1));
  for (const entry of unresolved) raiseIssue(db, accountId, 'zerodha', entry, at);
  return { resolved, unresolved };
}

/** Resolves every instrument the account's rows reference; idempotent. One transaction. */
export function resolveInstruments(
  db: Database.Database,
  accountId: string,
  options: ResolveOptions = {},
): ResolveSummary {
  const at = timestamp(options);
  return db.transaction(() => {
    const broker = db.prepare('SELECT broker FROM broker_account WHERE id = ?').pluck().get(accountId) as
      string | undefined;
    if (broker === undefined) throw new InstrumentError('unknown account');
    if (broker === 'dhan') return resolveDhan(db, accountId, at);
    if (broker === 'zerodha') return resolveZerodha(db, accountId, at);
    throw new InstrumentError('no instrument resolution for this broker');
  })();
}

export type ManualTarget =
  { readonly isin: string; readonly displayName?: string } | { readonly newDisplayName: string };

/** The user's mapping: always wins over automatic sources, and resolves the matching issues. */
export function mapInstrumentManually(
  db: Database.Database,
  ref: AliasRef,
  target: ManualTarget,
  options: ResolveOptions = {},
): void {
  const at = timestamp(options);
  if ('isin' in target && !ISIN.test(target.isin)) throw new InstrumentError('not a valid ISIN');
  db.transaction(() => {
    let instrumentId: string;
    if ('isin' in target) {
      instrumentId = instrumentFor(db, target.isin, target.displayName ?? ref.alias);
    } else {
      instrumentId = `ins_${randomUUID()}`;
      db.prepare('INSERT INTO instrument (id, isin, display_name) VALUES (?, NULL, ?)').run(
        instrumentId,
        target.newDisplayName,
      );
    }
    upsertAlias(db, ref, instrumentId, 'manual', at);
    resolveIssue(db, ref.broker, ref.alias, at);
  })();
}

export interface InstrumentSuggestion {
  readonly instrumentId: string;
  readonly isin: string | null;
  readonly name: string;
  readonly score: number;
}

/** Existing instruments ranked for an alias, by its display names and known aliases. */
export function suggestForAlias(
  db: Database.Database,
  ref: AliasRef,
  limit?: number,
): InstrumentSuggestion[] {
  const options = db
    .prepare(
      `SELECT id AS instrumentId, isin, display_name AS name FROM instrument
       UNION
       SELECT i.id, i.isin, a.alias FROM instrument_alias a JOIN instrument i ON i.id = a.instrument_id
       WHERE NOT (a.broker = ? AND a.alias = ?)`,
    )
    .all(ref.broker, ref.alias) as { instrumentId: string; isin: string | null; name: string }[];
  const ranked = suggestInstruments(ref.alias, options, Number.MAX_SAFE_INTEGER);
  const seen = new Set<string>();
  const unique = ranked.filter((entry) => !seen.has(entry.instrumentId) && seen.add(entry.instrumentId));
  return unique.slice(0, limit ?? 5);
}
