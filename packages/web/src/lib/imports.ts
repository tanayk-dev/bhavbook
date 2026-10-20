// Imports (PRD §5.1): preview files for an account, commit the preview, the import history with undo, and the
// coverage per report kind. Responses are untrusted JSON, checked here. File names never leave the browser: the
// preview is matched back to the chosen files by position (ADR-0019).
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isKind = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z]+\.[a-z0-9_]+$/.test(value);
const unexpected = (): never => {
  throw new ApiError(200, 'unexpected_response');
};

export interface NewAndDuplicate {
  readonly new: number;
  readonly duplicate: number;
}

export interface Counts {
  readonly rows: NewAndDuplicate;
  readonly statements: NewAndDuplicate;
  readonly skipped: Readonly<Record<string, number>>;
  readonly errors: number;
}

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface Forecast {
  readonly change: 'create' | 'resolve';
  readonly instrumentKey: string;
  readonly bucket: string;
  readonly orphanQty: string;
}

export type FilePreview = { readonly index: number } & (
  | {
      readonly status: 'ready';
      readonly kind: string;
      readonly counts: Counts;
      readonly errors: readonly { readonly line: number; readonly code: string }[];
      readonly coverage: DateRange | null;
      readonly warnings: readonly string[];
      readonly issueForecast: readonly Forecast[];
    }
  | { readonly status: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly status: 'rejected'; readonly kind: string; readonly message: string }
  | { readonly status: 'wrong_broker'; readonly broker: string; readonly kind: string }
  | { readonly status: 'unrecognised' }
  | { readonly status: 'unreadable'; readonly reason: 'too_large' | 'malformed' }
);

export interface Preview {
  readonly token: string | null;
  readonly expiresAt: string;
  readonly files: readonly FilePreview[];
}

function pair(value: unknown): NewAndDuplicate {
  return isRecord(value) && isCount(value.new) && isCount(value.duplicate)
    ? { new: value.new, duplicate: value.duplicate }
    : unexpected();
}

function counts(value: unknown): Counts {
  if (!isRecord(value) || !isRecord(value.skipped) || !isCount(value.errors)) return unexpected();
  const skipped: Record<string, number> = {};
  for (const [reason, n] of Object.entries(value.skipped)) skipped[reason] = isCount(n) ? n : unexpected();
  return { rows: pair(value.rows), statements: pair(value.statements), skipped, errors: value.errors };
}

function range(value: unknown): DateRange {
  return isRecord(value) && isDate(value.from) && isDate(value.to)
    ? { from: value.from, to: value.to }
    : unexpected();
}

function forecast(value: unknown): Forecast {
  if (
    isRecord(value) &&
    (value.change === 'create' || value.change === 'resolve') &&
    typeof value.instrumentKey === 'string' &&
    typeof value.bucket === 'string' &&
    typeof value.orphanQty === 'string' &&
    /^\d+$/.test(value.orphanQty)
  ) {
    return {
      change: value.change,
      instrumentKey: value.instrumentKey,
      bucket: value.bucket,
      orphanQty: value.orphanQty,
    };
  }
  return unexpected();
}

const list = <T>(value: unknown, item: (entry: unknown) => T): T[] =>
  Array.isArray(value) ? value.map(item) : unexpected();

function filePreview(value: unknown): FilePreview {
  if (!isRecord(value) || !isCount(value.index)) return unexpected();
  const { index } = value;
  switch (value.status) {
    case 'ready':
      if (!isKind(value.kind)) return unexpected();
      return {
        index,
        status: 'ready',
        kind: value.kind,
        counts: counts(value.counts),
        errors: list(value.errors, (entry) =>
          isRecord(entry) && isCount(entry.line) && typeof entry.code === 'string'
            ? { line: entry.line, code: entry.code }
            : unexpected(),
        ),
        coverage: value.coverage === null ? null : range(value.coverage),
        warnings: list(value.warnings, (entry) => (typeof entry === 'string' ? entry : unexpected())),
        issueForecast: list(value.issueForecast, forecast),
      };
    case 'ambiguous':
      return {
        index,
        status: 'ambiguous',
        candidates: list(value.candidates, (entry) =>
          isRecord(entry) && isKind(entry.kind) ? entry.kind : unexpected(),
        ),
      };
    case 'rejected':
      return isKind(value.kind) && typeof value.message === 'string'
        ? { index, status: 'rejected', kind: value.kind, message: value.message }
        : unexpected();
    case 'wrong_broker':
      return typeof value.broker === 'string' && isKind(value.kind)
        ? { index, status: 'wrong_broker', broker: value.broker, kind: value.kind }
        : unexpected();
    case 'unrecognised':
      return { index, status: 'unrecognised' };
    case 'unreadable':
      return value.reason === 'too_large' || value.reason === 'malformed'
        ? { index, status: 'unreadable', reason: value.reason }
        : unexpected();
    default:
      return unexpected();
  }
}

export function preview(body: unknown): Preview {
  if (
    isRecord(body) &&
    (body.token === null || (typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token))) &&
    typeof body.expiresAt === 'string'
  ) {
    return { token: body.token, expiresAt: body.expiresAt, files: list(body.files, filePreview) };
  }
  return unexpected();
}

export interface ChosenFile {
  readonly file: File;
  /** The person's pick when detection was ambiguous. */
  readonly kind?: string;
}

/** Previews files for an account. Only bytes and kind picks are sent; names stay here. */
export async function previewFiles(accountId: string, files: readonly ChosenFile[]): Promise<Preview> {
  const body = new FormData();
  for (const { file, kind } of files) {
    body.append('file', file, 'upload');
    body.append('kind', kind ?? '');
  }
  const target = `/api/imports?accountId=${encodeURIComponent(accountId)}`;
  return preview(
    await readJson(await send(() => fetch(target, { method: 'POST', credentials: 'same-origin', body }))),
  );
}

export interface Committed {
  readonly rows: number;
  readonly statements: number;
}

/** Commits a preview; returns what it added across all its files. */
export async function commitPreview(token: string): Promise<Committed> {
  const body = await readJson(await send(() => api.imports.commit.$post({ json: { token } })));
  const batches = isRecord(body) ? list(body.batches, (entry) => entry) : unexpected();
  return batches.reduce<Committed>(
    (total, batch) => {
      const inserted = isRecord(batch) && isRecord(batch.inserted) ? batch.inserted : unexpected();
      return isCount(inserted.rows) && isCount(inserted.statements)
        ? { rows: total.rows + inserted.rows, statements: total.statements + inserted.statements }
        : unexpected();
    },
    { rows: 0, statements: 0 },
  );
}

export interface ImportRecord {
  readonly id: string;
  readonly kind: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly counts: Counts;
  readonly createdAt: string;
}

function importRecord(value: unknown): ImportRecord {
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isKind(value.kind) &&
    (value.from === null || isDate(value.from)) &&
    (value.to === null || isDate(value.to)) &&
    typeof value.createdAt === 'string' &&
    /(Z|[+-]\d\d:\d\d)$/.test(value.createdAt)
  ) {
    return {
      id: value.id,
      kind: value.kind,
      from: value.from,
      to: value.to,
      counts: counts(value.counts),
      createdAt: value.createdAt,
    };
  }
  return unexpected();
}

export const importsQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['imports', accountId],
    queryFn: async () => {
      const body = await readJson(await send(() => api.imports.$get({ query: { accountId } })));
      return isRecord(body) ? list(body.imports, importRecord) : unexpected();
    },
  });

/** Undoes one import; returns how many trade rows left the account. */
export async function undoImport(id: string): Promise<number> {
  const body = await readJson(await send(() => api.imports[':id'].$delete({ param: { id } })));
  const removed = isRecord(body) && isRecord(body.removed) ? body.removed : unexpected();
  return isCount(removed.rows) ? removed.rows : unexpected();
}

export interface KindCoverage {
  readonly kind: string;
  readonly ranges: readonly DateRange[];
  readonly gaps: readonly DateRange[];
}

export const coverageQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['coverage', accountId],
    queryFn: async (): Promise<KindCoverage[]> => {
      const body = await readJson(await send(() => api.coverage.$get({ query: { accountId } })));
      return isRecord(body)
        ? list(body.coverage, (entry) =>
            isRecord(entry) && isKind(entry.kind)
              ? { kind: entry.kind, ranges: list(entry.ranges, range), gaps: list(entry.gaps, range) }
              : unexpected(),
          )
        : unexpected();
    },
  });

export interface ReportGuide {
  readonly label: string;
  /** Where the broker offers it (from docs/broker-exports/<broker>/NOTES.md). */
  readonly where: string;
  /** The broker's site to open: a plain link, nothing is fetched by BhavBook. */
  readonly url: string;
  readonly limit: string;
}

/** Report kinds the adapters read, with where to download each. */
export const REPORTS: Readonly<Record<string, ReportGuide>> = {
  'zerodha.tradebook': {
    label: 'Zerodha tradebook',
    where: 'console.zerodha.com/reports/tradebook',
    url: 'https://console.zerodha.com/reports/tradebook',
    limit: 'up to 365 days per download',
  },
  'zerodha.tradebook_external': {
    label: 'Zerodha tradebook (external format)',
    where: 'console.zerodha.com/reports/tradebook',
    url: 'https://console.zerodha.com/reports/tradebook',
    limit: 'up to 365 days per download',
  },
  'zerodha.pnl': {
    label: 'Zerodha P&L',
    where: 'console.zerodha.com/reports/pnl',
    url: 'https://console.zerodha.com/reports/pnl',
    limit: 'any range',
  },
  'zerodha.tax_pnl': {
    label: 'Zerodha tax P&L',
    where: 'console.zerodha.com/reports/taxpnl',
    url: 'https://console.zerodha.com/reports/taxpnl',
    limit: 'one FY',
  },
  'zerodha.agts': {
    label: 'Zerodha Annual Global Statement',
    where: 'console.zerodha.com/reports/downloads',
    url: 'https://console.zerodha.com/reports/downloads',
    limit: 'one FY',
  },
  'dhan.trade_history': {
    label: 'Dhan trade history',
    where: 'web.dhan.co → Profile → Statements & Reports → All Exchange Transactions',
    url: 'https://web.dhan.co/index/profile',
    limit: 'any range',
  },
  'dhan.global_transactions': {
    label: 'Dhan global transactions',
    where: 'journal.dhan.co → Statements & Reports → Global',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
  'dhan.dp_charges': {
    label: 'Dhan DP charges',
    where: 'journal.dhan.co → Statements & Reports → DP Transaction',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
  'dhan.tax_report': {
    label: 'Dhan tax report',
    where: 'journal.dhan.co → Tax Saving → Tax Report',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
  'dhan.pnl': {
    label: 'Dhan P&L',
    where: 'journal.dhan.co → Statements & Reports → P&L',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
  'dhan.realised_pnl': {
    label: 'Dhan realised P&L',
    where: 'journal.dhan.co → Statements & Reports → Realised P&L',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
  'dhan.ledger': {
    label: 'Dhan ledger',
    where: 'journal.dhan.co → Statements & Reports → Ledger',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
  'dhan.fund_summary': {
    label: 'Dhan fund summary',
    where: 'journal.dhan.co → Statements & Reports → Fund',
    url: 'https://journal.dhan.co',
    limit: 'one FY',
  },
};

export const reportLabel = (kind: string): string => REPORTS[kind]?.label ?? kind;

const SKIP_REASONS: Readonly<Record<string, string>> = {
  fno: 'F&O',
  currency: 'currency',
  commodity: 'commodity',
  mf: 'mutual funds',
  not_traded: 'not executed',
  other: 'other',
};

export const skipReason = (reason: string): string => SKIP_REASONS[reason] ?? reason;

const IMPORT_ERRORS: Readonly<Record<string, string>> = {
  not_found: 'That account no longer exists. Reload the page.',
  no_files: 'Choose at least one file.',
  too_large: 'Those files are too large to preview together. Preview fewer at a time.',
  too_many_files: 'Preview at most 10 files at a time.',
  payload_too_large: 'Those files are too large to preview together. Preview fewer at a time.',
  preview_expired: 'This preview has expired or was already imported. Preview the files again.',
  backup_failed:
    'BhavBook could not back up before importing, so nothing was imported. Check the disk has space.',
};

export const importError = (error: unknown): string =>
  (error instanceof ApiError ? IMPORT_ERRORS[error.code] : undefined) ?? 'That did not work. Try again.';
