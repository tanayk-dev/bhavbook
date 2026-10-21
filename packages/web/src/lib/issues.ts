// The issues inbox (PRD §4): the listing, the summary for the navigation badge, and each kind's fix. Responses are
// untrusted JSON, checked here; an issue's subject is read per kind into a typed shape, and a subject that doesn't
// fit its kind is shown as "details unavailable" rather than guessed at.
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const digits = (value: unknown): bigint | null =>
  typeof value === 'string' && /^-?\d{1,19}$/.test(value) ? BigInt(value) : null;
const unexpected = (): never => {
  throw new ApiError(200, 'unexpected_response');
};

export type IssueStatus = 'open' | 'dismissed' | 'resolved';

export interface Issue {
  readonly id: string;
  readonly kind: string;
  readonly status: IssueStatus;
  readonly accountId: string | null;
  readonly accountNickname: string | null;
  readonly broker: string | null;
  readonly subject: unknown;
  readonly createdAt: string;
}

export interface IssueList {
  readonly issues: readonly Issue[];
  readonly total: number;
  readonly instruments: Readonly<Record<string, string>>;
}

function issue(value: unknown): Issue {
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    (value.status === 'open' || value.status === 'dismissed' || value.status === 'resolved') &&
    (value.accountId === null || typeof value.accountId === 'string') &&
    (value.accountNickname === null || typeof value.accountNickname === 'string') &&
    (value.broker === null || typeof value.broker === 'string') &&
    typeof value.createdAt === 'string'
  ) {
    return {
      id: value.id,
      kind: value.kind,
      status: value.status,
      accountId: value.accountId,
      accountNickname: value.accountNickname,
      broker: value.broker,
      subject: value.subject,
      createdAt: value.createdAt,
    };
  }
  return unexpected();
}

export function issueList(body: unknown): IssueList {
  if (
    !isRecord(body) ||
    !Array.isArray(body.issues) ||
    typeof body.total !== 'number' ||
    !isRecord(body.instruments)
  ) {
    return unexpected();
  }
  const instruments: Record<string, string> = {};
  for (const [key, name] of Object.entries(body.instruments))
    if (typeof name === 'string') instruments[key] = name;
  return { issues: body.issues.map(issue), total: body.total, instruments };
}

export interface IssueQuery {
  readonly status: IssueStatus;
  readonly kind?: string;
  readonly accountId?: string;
}

export const issuesQuery = (filter: IssueQuery) =>
  queryOptions({
    queryKey: ['issues', filter],
    queryFn: async () =>
      issueList(
        await readJson(
          await send(() =>
            api.issues.$get({
              query: {
                status: filter.status,
                ...(filter.kind === undefined ? {} : { kind: filter.kind }),
                ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
              },
            }),
          ),
        ),
      ),
  });

export interface IssueSummary {
  readonly open: number;
  readonly byKind: Readonly<Record<string, number>>;
}

export const issueSummaryQuery = queryOptions({
  queryKey: ['issues', 'summary'],
  queryFn: async (): Promise<IssueSummary> => {
    const body = await readJson(await send(() => api.issues.summary.$get()));
    if (!isRecord(body) || typeof body.open !== 'number' || !isRecord(body.byKind)) return unexpected();
    const byKind: Record<string, number> = {};
    for (const [kind, count] of Object.entries(body.byKind))
      if (typeof count === 'number') byKind[kind] = count;
    return { open: body.open, byKind };
  },
});

// Each kind's subject, read leniently: a field of the wrong type makes the whole subject unreadable (null).

export interface LotSuggestion {
  readonly instrumentKey: string;
  readonly bucket: string;
  readonly quantity: bigint;
  readonly totalCostMicro: bigint;
  readonly entryDateIst: string;
}

export function lotSuggestion(subject: unknown): LotSuggestion | null {
  if (!isRecord(subject)) return null;
  const instrumentKey = text(subject.instrumentKey);
  const bucket = text(subject.bucket);
  const quantity = digits(subject.quantity);
  const totalCostMicro = digits(subject.totalCostMicro);
  const entryDateIst = text(subject.entryDateIst);
  if (
    instrumentKey === null ||
    bucket === null ||
    quantity === null ||
    totalCostMicro === null ||
    entryDateIst === null
  ) {
    return null;
  }
  return { instrumentKey, bucket, quantity, totalCostMicro, entryDateIst };
}

export interface IncompletePosition {
  readonly instrumentKey: string;
  readonly bucket: string;
  readonly orphanQty: bigint;
  readonly openedAtUtc: string;
  /** The position's anchor, which an exclusion names; null on issues raised before it was recorded. */
  readonly anchorKey: string | null;
}

export function incompletePosition(subject: unknown): IncompletePosition | null {
  if (!isRecord(subject)) return null;
  const instrumentKey = text(subject.instrumentKey);
  const bucket = text(subject.bucket);
  const orphanQty = digits(subject.orphanQty);
  const openedAtUtc = text(subject.openedAtUtc);
  if (instrumentKey === null || bucket === null || orphanQty === null || openedAtUtc === null) return null;
  return { instrumentKey, bucket, orphanQty, openedAtUtc, anchorKey: text(subject.anchorKey) };
}

export interface UnresolvedInstrument {
  readonly alias: string;
  readonly reason: string;
}

export function unresolvedInstrument(subject: unknown): UnresolvedInstrument | null {
  if (!isRecord(subject)) return null;
  const alias = text(subject.alias);
  return alias === null ? null : { alias, reason: text(subject.reason) ?? '' };
}

export interface FeeDifference {
  readonly scope: string;
  readonly dateIst: string;
  readonly component: string;
  readonly instrumentKey: string | null;
  readonly estimatedMicro: bigint;
  readonly reportedMicro: bigint;
}

export interface FeeDiscrepancy {
  readonly instrumentKey: string | null;
  readonly bucket: string | null;
  readonly differences: readonly FeeDifference[];
  /** A statement row that matched no trade (no differences then). */
  readonly unmatchedRow: { readonly dateIst: string; readonly instrumentKey: string | null } | null;
}

export function feeDiscrepancy(subject: unknown): FeeDiscrepancy | null {
  if (!isRecord(subject)) return null;
  if (subject.unmatchedStatementRow === true) {
    const dateIst = text(subject.dateIst);
    if (dateIst === null) return null;
    return {
      instrumentKey: null,
      bucket: null,
      differences: [],
      unmatchedRow: { dateIst, instrumentKey: text(subject.instrumentKey) },
    };
  }
  if (!Array.isArray(subject.discrepancies)) return null;
  const differences: FeeDifference[] = [];
  for (const entry of subject.discrepancies) {
    if (!isRecord(entry)) return null;
    const scope = text(entry.scope);
    const dateIst = text(entry.dateIst);
    const component = text(entry.component);
    const estimatedMicro = digits(entry.estimatedMicro);
    const reportedMicro = digits(entry.reportedMicro);
    if (
      scope === null ||
      dateIst === null ||
      component === null ||
      estimatedMicro === null ||
      reportedMicro === null
    ) {
      return null;
    }
    differences.push({
      scope,
      dateIst,
      component,
      instrumentKey: text(entry.instrumentKey),
      estimatedMicro,
      reportedMicro,
    });
  }
  return {
    instrumentKey: text(subject.instrumentKey),
    bucket: text(subject.bucket),
    differences,
    unmatchedRow: null,
  };
}

export interface FifoMismatch {
  readonly isin: string;
  readonly buyDateIst: string;
  readonly sellDateIst: string;
  readonly ourQuantity: bigint;
  readonly statementQuantity: bigint;
  readonly ourValueMicro: bigint;
  readonly statementValueMicro: bigint;
}

export function fifoMismatch(subject: unknown): FifoMismatch | null {
  if (!isRecord(subject)) return null;
  const isin = text(subject.isin);
  const buyDateIst = text(subject.buyDateIst);
  const sellDateIst = text(subject.sellDateIst);
  const ourQuantity = digits(subject.ourQuantity);
  const statementQuantity = digits(subject.statementQuantity);
  const ourValueMicro = digits(subject.ourValueMicro);
  const statementValueMicro = digits(subject.statementValueMicro);
  if (
    isin === null ||
    buyDateIst === null ||
    sellDateIst === null ||
    ourQuantity === null ||
    statementQuantity === null ||
    ourValueMicro === null ||
    statementValueMicro === null
  ) {
    return null;
  }
  return {
    isin,
    buyDateIst,
    sellDateIst,
    ourQuantity,
    statementQuantity,
    ourValueMicro,
    statementValueMicro,
  };
}

/** The instrument key a subject is about, when it names one. */
export function subjectInstrument(subject: unknown): string | null {
  return isRecord(subject) ? (text(subject.instrumentKey) ?? text(subject.isin)) : null;
}

// Actions. Each answers once the server has recomputed, so refetching the inbox shows the result.

const post = (path: string, json?: unknown) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    ...(json === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
  });

export async function issueAction(
  id: string,
  action: 'dismiss' | 'reopen' | 'accept' | 'replace',
): Promise<void> {
  await readJson(await send(() => post(`/api/issues/${encodeURIComponent(id)}/${action}`)));
}

export interface InstrumentSuggestion {
  readonly instrumentId: string;
  readonly isin: string | null;
  readonly name: string;
}

export async function instrumentSuggestions(id: string): Promise<InstrumentSuggestion[]> {
  const body = await readJson(await send(() => api.issues[':id'].suggestions.$get({ param: { id } })));
  if (!isRecord(body) || !Array.isArray(body.suggestions)) return unexpected();
  return body.suggestions.map((entry: unknown) =>
    isRecord(entry) &&
    typeof entry.instrumentId === 'string' &&
    (entry.isin === null || typeof entry.isin === 'string') &&
    typeof entry.name === 'string'
      ? { instrumentId: entry.instrumentId, isin: entry.isin, name: entry.name }
      : unexpected(),
  );
}

export type InstrumentTarget =
  { readonly isin: string; readonly displayName?: string } | { readonly newDisplayName: string };

export async function mapInstrument(id: string, target: InstrumentTarget): Promise<void> {
  await readJson(await send(() => post(`/api/issues/${encodeURIComponent(id)}/map`, target)));
}

export type AdjustmentInput =
  | {
      readonly kind: 'opening_lot';
      readonly instrumentKey: string;
      readonly bucket: 'DELIVERY' | 'MTF';
      readonly quantity: string;
      readonly totalCostMicro: string;
      readonly entryDateIst: string;
    }
  | { readonly kind: 'exclude'; readonly anchorKey: string }
  | {
      readonly kind: 'product_override';
      readonly instrumentKey: string;
      readonly tradeDateIst: string;
      readonly bucket: 'DELIVERY' | 'INTRADAY' | 'MTF';
    };

export async function addAdjustment(accountId: string, input: AdjustmentInput): Promise<string> {
  const body = await readJson(
    await send(() => post(`/api/accounts/${encodeURIComponent(accountId)}/adjustments`, input)),
  );
  return isRecord(body) && typeof body.id === 'string' ? body.id : unexpected();
}

const ACTION_ERRORS: Readonly<Record<string, string>> = {
  not_found: 'This issue changed meanwhile. The list has been refreshed.',
  invalid: 'That does not match this account. Check the details and try again.',
  invalid_request: 'Some details are missing or malformed.',
};

export const actionError = (error: unknown): string =>
  (error instanceof ApiError ? ACTION_ERRORS[error.code] : undefined) ?? 'That did not work. Try again.';

/** What each kind is, in a few words, for headings and the kind filter. */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  fill_from_statement: 'Fill from broker statement',
  incomplete_position: 'Incomplete position',
  opening_lot_redundant: 'Opening lot no longer needed',
  unresolved_instrument: 'Unknown instrument',
  fee_discrepancy: 'Charges differ from the statement',
  fifo_mismatch: 'Lots differ from the tax report',
  corporate_action_suspected: 'Possible corporate action',
  cash_in_lieu: 'Fraction paid as cash',
  journal_unattached: 'Journal entry without a position',
  journal_collision: 'Two journal entries on one position',
  fees_unrated: 'Charges unknown for some trades',
  charges_unattached: 'Charges of cashed-out shares',
  recompute_failed: 'Positions could not be rebuilt',
};

export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
