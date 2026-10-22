// The diagnostics export (PRD §3.3, plan S14b): what a bug report needs, never what identifies the user or their
// trades. App and schema version, OS and Node, and per import batch: the report kind, adapter version, status,
// counts and error codes, and the *shapes* of its rows (column count and the type of each column; for statement
// rows, field names and value types). Never a cell value, a file name, a hash or an id (ADR-0019); a test scans the
// export of the real fixtures for their values.
import { arch, platform, release } from 'node:os';
import type Database from 'better-sqlite3';
import { currentVersion } from '../vault/index.js';

/** Distinct shapes kept per batch; the rest are counted. */
const MAX_SHAPES = 10;

export type CellType = 'empty' | 'integer' | 'decimal' | 'date' | 'time' | 'datetime' | 'boolean' | 'text';

const PATTERNS: readonly [CellType, RegExp][] = [
  ['empty', /^$/],
  ['integer', /^[+-]?\d+$/],
  ['decimal', /^[+-]?(\d+\.\d*|\.\d+)$/],
  ['date', /^(\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4})$/],
  ['time', /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/],
  ['datetime', /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/],
  ['boolean', /^(true|false)$/i],
];

/** What kind of value a cell holds, never the value. */
export function cellType(value: string): CellType {
  const trimmed = value.trim();
  return PATTERNS.find(([, pattern]) => pattern.test(trimmed))?.[0] ?? 'text';
}

/** One CSV line's cells (quoted cells may hold commas and doubled quotes). */
export function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    if (quoted) {
      if (char === '"' && line[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

const valueType = (value: unknown): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'string'
        ? cellType(value)
        : typeof value;

/** A statement row's shape: its field names and value types (nested objects by their own shape). */
function jsonShape(json: string): string {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return valueType(value);
    return Object.entries(value)
      .map(([key, item]) => `${key}:${valueType(item)}`)
      .sort()
      .join(',');
  } catch {
    return 'unreadable';
  }
}

export interface Shape {
  /** For trade rows: the column count; for statement rows: the statement kind. */
  readonly of: string;
  readonly shape: string;
  readonly rows: number;
}

function tally(keys: readonly { of: string; shape: string }[]): { shapes: Shape[]; otherRows: number } {
  const counts = new Map<string, Shape>();
  for (const { of, shape } of keys) {
    const key = `${of}|${shape}`;
    const current = counts.get(key);
    counts.set(key, { of, shape, rows: (current?.rows ?? 0) + 1 });
  }
  const sorted = [...counts.values()].sort((a, b) => b.rows - a.rows || (a.shape < b.shape ? -1 : 1));
  const kept = sorted.slice(0, MAX_SHAPES);
  return { shapes: kept, otherRows: sorted.slice(MAX_SHAPES).reduce((sum, shape) => sum + shape.rows, 0) };
}

/** Numbers and reason codes only: anything else in a batch's counts is left out. */
function numbersOnly(json: string): Record<string, unknown> {
  const keep = (value: unknown): unknown => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const entries = Object.entries(value)
      .filter(([key]) => /^[a-z][a-z0-9_]{0,40}$/i.test(key))
      .map(([key, item]) => [key, keep(item)] as const)
      .filter(([, item]) => item !== undefined);
    return Object.fromEntries(entries);
  };
  try {
    const kept = keep(JSON.parse(json));
    return typeof kept === 'object' && kept !== null ? (kept as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface BatchDiagnostics {
  readonly broker: string;
  readonly reportKind: string;
  readonly adapterVersion: string;
  readonly status: string;
  readonly importedOn: string;
  readonly counts: Record<string, unknown>;
  readonly tradeRows: number;
  readonly statementRows: number;
  readonly tradeShapes: Shape[];
  readonly statementShapes: Shape[];
  /** Rows whose shapes did not fit in the list. */
  readonly otherShapeRows: number;
}

export interface Diagnostics {
  readonly format: 'bhavbook-diagnostics/1';
  readonly generatedAt: string;
  readonly app: { readonly version: string; readonly schemaVersion: number };
  readonly runtime: {
    readonly node: string;
    readonly os: string;
    readonly osRelease: string;
    readonly arch: string;
  };
  readonly accounts: { readonly broker: string; readonly batches: number }[];
  readonly batches: BatchDiagnostics[];
  readonly positions: Record<string, number>;
  readonly issues: Record<string, number>;
}

export interface DiagnosticsOptions {
  readonly appVersion?: string;
  readonly now?: () => Date;
}

function batchDiagnostics(db: Database.Database): BatchDiagnostics[] {
  const batches = db
    .prepare(
      `SELECT b.id, a.broker, b.report_kind, b.adapter_version, b.status, b.counts_json, b.created_at
       FROM import_batch b JOIN broker_account a ON a.id = b.account_id ORDER BY b.created_at, b.id`,
    )
    .all() as {
    id: string;
    broker: string;
    report_kind: string;
    adapter_version: string;
    status: string;
    counts_json: string;
    created_at: string;
  }[];
  const raw = db.prepare('SELECT raw_text FROM raw_row WHERE batch_id = ?').pluck();
  const statements = db.prepare('SELECT kind, data_json FROM statement_row WHERE batch_id = ?');
  const trades = db.prepare('SELECT count(*) FROM trade_row WHERE batch_id = ?').pluck();
  return batches.map((batch) => {
    const lines = raw.all(batch.id) as string[];
    const rows = statements.all(batch.id) as { kind: string; data_json: string }[];
    const tradeTally = tally(
      lines.map((line) => {
        const cells = csvCells(line);
        return { of: `${String(cells.length)} columns`, shape: cells.map(cellType).join(',') };
      }),
    );
    const statementTally = tally(rows.map((row) => ({ of: row.kind, shape: jsonShape(row.data_json) })));
    return {
      broker: batch.broker,
      reportKind: batch.report_kind,
      adapterVersion: batch.adapter_version,
      status: batch.status,
      importedOn: batch.created_at.slice(0, 10),
      counts: numbersOnly(batch.counts_json),
      tradeRows: Number(trades.get(batch.id)),
      statementRows: rows.length,
      tradeShapes: tradeTally.shapes,
      statementShapes: statementTally.shapes,
      otherShapeRows: tradeTally.otherRows + statementTally.otherRows,
    };
  });
}

const countsBy = (db: Database.Database, sql: string): Record<string, number> =>
  Object.fromEntries(
    (db.prepare(sql).all() as { key: string; n: bigint }[]).map((row) => [row.key, Number(row.n)]),
  );

/** The diagnostics of the open vault. */
export function diagnostics(db: Database.Database, options: DiagnosticsOptions = {}): Diagnostics {
  return {
    format: 'bhavbook-diagnostics/1',
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    app: { version: options.appVersion ?? 'unknown', schemaVersion: currentVersion(db) },
    runtime: { node: process.version, os: platform(), osRelease: release(), arch: arch() },
    accounts: (
      db
        .prepare(
          `SELECT a.broker, count(b.id) AS batches FROM broker_account a
           LEFT JOIN import_batch b ON b.account_id = a.id GROUP BY a.id ORDER BY a.broker, a.created_at`,
        )
        .all() as { broker: string; batches: bigint }[]
    ).map((row) => ({ broker: row.broker, batches: Number(row.batches) })),
    batches: batchDiagnostics(db),
    positions: countsBy(
      db,
      `SELECT CASE WHEN incomplete = 1 THEN 'INCOMPLETE' WHEN excluded = 1 THEN 'EXCLUDED' ELSE state END AS key,
         count(*) AS n FROM position GROUP BY key`,
    ),
    issues: countsBy(db, "SELECT kind || ':' || status AS key, count(*) AS n FROM issue GROUP BY key"),
  };
}
