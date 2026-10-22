// Corporate actions (PRD §7.4, ADR-0015): the list, the preview of affected lots, applying, reverting and restoring.
// Responses are untrusted JSON, checked here; quantities and money are decimal strings and become bigint. Ratios
// read "you get `ratioNum` new shares for every `ratioDen` held" (a 1:5 split is 5 for 1).
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const unexpected = (): never => {
  throw new ApiError(200, 'unexpected_response');
};
const str = (value: unknown): string => (typeof value === 'string' ? value : unexpected());
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : str(value);
const big = (value: unknown): bigint =>
  typeof value === 'string' && /^-?\d{1,19}$/.test(value) ? BigInt(value) : unexpected();
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : unexpected());
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : unexpected());

export const ACTION_TYPES = ['SPLIT', 'BONUS', 'CONVERSION', 'DEMERGER'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
const actionType = (value: unknown): ActionType =>
  ACTION_TYPES.find((type) => type === value) ?? unexpected();

/** What a form sends: the server's input, every number a decimal string. */
export interface CorporateActionInput {
  readonly type: ActionType;
  readonly isin: string;
  readonly newIsin?: string;
  readonly exDateIst: string;
  readonly allotmentDateIst?: string;
  readonly ratioNum: string;
  readonly ratioDen: string;
  /** Demerger: the child's share of the cost, in basis points. */
  readonly costSplitBp?: string;
}

export type StoredAction =
  | {
      readonly id: string;
      readonly unreadable: false;
      readonly type: ActionType;
      readonly isin: string;
      readonly newIsin: string | null;
      readonly exDateIst: string;
      readonly allotmentDateIst: string | null;
      readonly ratioNum: bigint;
      readonly ratioDen: bigint;
      readonly costSplitBp: bigint | null;
      readonly status: 'active' | 'reverted';
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly unreadable: true;
      readonly status: 'active' | 'reverted';
      readonly createdAt: string;
    };

const status = (value: unknown): 'active' | 'reverted' =>
  value === 'active' || value === 'reverted' ? value : unexpected();

function storedAction(value: unknown): StoredAction {
  const row = record(value);
  if (row.unreadable === true) {
    return { id: str(row.id), unreadable: true, status: status(row.status), createdAt: str(row.createdAt) };
  }
  return {
    id: str(row.id),
    unreadable: false,
    type: actionType(row.type),
    isin: str(row.isin),
    newIsin: strOrNull(row.newIsin),
    exDateIst: str(row.exDateIst),
    allotmentDateIst: strOrNull(row.allotmentDateIst),
    ratioNum: big(row.ratioNum),
    ratioDen: big(row.ratioDen),
    costSplitBp: row.costSplitBp === null ? null : big(row.costSplitBp),
    status: status(row.status),
    createdAt: str(row.createdAt),
  };
}

function names(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, name] of Object.entries(record(value))) if (typeof name === 'string') result[key] = name;
  return result;
}

export interface ActionList {
  readonly actions: readonly StoredAction[];
  readonly instruments: Readonly<Record<string, string>>;
}

export function actionList(body: unknown): ActionList {
  const value = record(body);
  return { actions: list(value.actions).map(storedAction), instruments: names(value.instruments) };
}

export const corporateActionsQuery = queryOptions({
  queryKey: ['corporate-actions'],
  queryFn: async () => actionList(await readJson(await send(() => api['corporate-actions'].$get()))),
});

export interface PreviewLot {
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly bucket: string;
  readonly quantity: bigint;
  readonly costMicro: bigint;
  readonly entryDateIst: string;
}

export interface PreviewFraction {
  readonly accountId: string;
  readonly instrumentKey: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface ActionPreview {
  readonly before: readonly PreviewLot[];
  readonly after: readonly PreviewLot[];
  readonly fractions: readonly PreviewFraction[];
  readonly instruments: Readonly<Record<string, string>>;
  readonly accounts: Readonly<Record<string, { readonly nickname: string; readonly profileId: string }>>;
}

function lot(value: unknown): PreviewLot {
  const row = record(value);
  return {
    accountId: str(row.accountId),
    instrumentKey: str(row.instrumentKey),
    bucket: str(row.bucket),
    quantity: big(row.quantity),
    costMicro: big(row.costMicro),
    entryDateIst: str(row.entryDateIst),
  };
}

export function actionPreview(body: unknown): ActionPreview {
  const value = record(body);
  const accounts: Record<string, { nickname: string; profileId: string }> = {};
  for (const [id, account] of Object.entries(record(value.accounts))) {
    const entry = record(account);
    accounts[id] = { nickname: str(entry.nickname), profileId: str(entry.profileId) };
  }
  return {
    before: list(value.before).map(lot),
    after: list(value.after).map(lot),
    fractions: list(value.fractions).map((entry) => {
      const fraction = record(entry);
      return {
        accountId: str(fraction.accountId),
        instrumentKey: str(fraction.instrumentKey),
        numerator: big(fraction.numerator),
        denominator: big(fraction.denominator),
      };
    }),
    instruments: names(value.instruments),
    accounts,
  };
}

const post = (path: string, json?: unknown) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    ...(json === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
  });

/** What an action would do to every account's open lots; stores nothing. */
export async function previewAction(input: CorporateActionInput): Promise<ActionPreview> {
  return actionPreview(await readJson(await send(() => post('/api/corporate-actions/preview', input))));
}

/** Stores the action and rebuilds every account; returns its id. */
export async function applyAction(input: CorporateActionInput): Promise<string> {
  const body = record(await readJson(await send(() => post('/api/corporate-actions', input))));
  return str(body.id);
}

export async function setActionStatus(id: string, action: 'revert' | 'restore'): Promise<void> {
  await readJson(await send(() => post(`/api/corporate-actions/${encodeURIComponent(id)}/${action}`)));
}

/** Basis points from a percentage as typed ("31.15" → "3115"): string arithmetic, at most two decimals. */
export function percentToBp(text: string): string | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const bp =
    Number.parseInt(match[1] ?? '0', 10) * 100 + Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10);
  return bp <= 10_000 ? String(bp) : null;
}

const ERRORS: Readonly<Record<string, string>> = {
  invalid:
    'Those details do not describe a valid action: check the ISINs (12 characters), the dates and the ratio, and for a demerger the child ISIN and cost split.',
  invalid_request: 'Some details are missing or malformed.',
  conflict:
    'This conflicts with what is stored: an identical action is already active, an unreadable action needs reverting first, or the action does not fit an account history.',
  not_found: 'This action changed meanwhile. The list has been refreshed.',
};

export const actionError = (error: unknown): string =>
  (error instanceof ApiError ? ERRORS[error.code] : undefined) ?? 'That did not work. Try again.';
