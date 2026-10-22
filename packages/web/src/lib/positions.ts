// Positions for the review queue and the position detail (PRD §4, §5.2, §5.3). Responses are untrusted JSON, checked
// here; money arrives as decimal strings of micro-rupees and becomes bigint. A position is addressed by its `ref`,
// which the server derives from the position's anchor, so a link to it survives recomputes.
import { queryOptions } from '@tanstack/react-query';
import type { ProvenanceKind } from '@/components/provenance';
import { api, ApiError, readJson, send } from '@/lib/api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const unexpected = (): never => {
  throw new ApiError(200, 'unexpected_response');
};
const str = (value: unknown): string => (typeof value === 'string' ? value : unexpected());
const strOrNull = (value: unknown): string | null => (value === null ? null : str(value));
/** A UTC instant as the server writes it (ISO 8601); anything else is unexpected. */
const instant = (value: unknown): string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : unexpected();
const instantOrNull = (value: unknown): string | null => (value === null ? null : instant(value));
const date = (value: unknown): string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : unexpected();
const dateOrNull = (value: unknown): string | null => (value === null ? null : date(value));
const big = (value: unknown): bigint =>
  typeof value === 'string' && /^-?\d{1,19}$/.test(value) ? BigInt(value) : unexpected();
const bigOrNull = (value: unknown): bigint | null => (value === null ? null : big(value));
const bool = (value: unknown): boolean => (typeof value === 'boolean' ? value : unexpected());
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : unexpected();
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : unexpected());
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : unexpected());

function names(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, name] of Object.entries(record(value))) if (typeof name === 'string') result[key] = name;
  return result;
}

export type PositionState = 'OPEN' | 'CLOSED';

export interface PositionSummary {
  readonly ref: string;
  readonly accountId: string;
  readonly accountNickname: string;
  readonly broker: string;
  readonly instrumentKey: string;
  readonly bucket: string;
  readonly state: PositionState;
  readonly incomplete: boolean;
  readonly excluded: boolean;
  readonly orphanQty: bigint;
  readonly openedAtUtc: string;
  readonly closedAtUtc: string | null;
  readonly openQty: bigint;
  readonly boughtQty: bigint;
  readonly boughtValueMicro: bigint;
  readonly soldValueMicro: bigint;
  readonly realisedGrossMicro: bigint;
  readonly chargesMicro: bigint;
  readonly feeStatus: string | null;
  readonly reviewedAt: string | null;
  readonly journalEntries: number;
}

export function positionSummary(value: unknown): PositionSummary {
  const row = record(value);
  const state = row.state === 'OPEN' || row.state === 'CLOSED' ? row.state : unexpected();
  return {
    ref: str(row.ref),
    accountId: str(row.accountId),
    accountNickname: str(row.accountNickname),
    broker: str(row.broker),
    instrumentKey: str(row.instrumentKey),
    bucket: str(row.bucket),
    state,
    incomplete: bool(row.incomplete),
    excluded: bool(row.excluded),
    orphanQty: big(row.orphanQty),
    openedAtUtc: instant(row.openedAtUtc),
    closedAtUtc: instantOrNull(row.closedAtUtc),
    openQty: big(row.openQty),
    boughtQty: big(row.boughtQty),
    boughtValueMicro: big(row.boughtValueMicro),
    soldValueMicro: big(row.soldValueMicro),
    realisedGrossMicro: big(row.realisedGrossMicro),
    chargesMicro: big(row.chargesMicro),
    feeStatus: strOrNull(row.feeStatus),
    reviewedAt: instantOrNull(row.reviewedAt),
    journalEntries: num(row.journalEntries),
  };
}

export interface PositionList {
  readonly positions: readonly PositionSummary[];
  readonly total: number;
  readonly instruments: Readonly<Record<string, string>>;
}

export function positionList(body: unknown): PositionList {
  const value = record(body);
  return {
    positions: list(value.positions).map(positionSummary),
    total: num(value.total),
    instruments: names(value.instruments),
  };
}

export type ReviewFilter = 'unreviewed' | 'reviewed';

/** The server's most per page; the page says when there are more. */
export const QUEUE_LIMIT = 500;

export const reviewQueueQuery = (review: ReviewFilter) =>
  queryOptions({
    queryKey: ['positions', 'review', review],
    queryFn: async () =>
      positionList(
        await readJson(
          await send(() => api.positions.$get({ query: { review, limit: String(QUEUE_LIMIT) } })),
        ),
      ),
  });

export const reviewCountQuery = queryOptions({
  queryKey: ['positions', 'review-count'],
  queryFn: async (): Promise<number> => {
    const body = record(await readJson(await send(() => api.positions['review-count'].$get({ query: {} }))));
    return num(body.count);
  },
});

export interface PositionFill {
  readonly allocationId: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: bigint;
  readonly valueMicro: bigint;
  readonly bucket: string;
  readonly inferred: boolean;
  readonly source: 'trade' | 'opening_lot' | 'corporate_action';
  readonly trade: {
    readonly executedAtUtc: string;
    readonly tradeDateIst: string;
    readonly exchange: string;
    readonly quantity: bigint;
    readonly priceMicro: bigint;
    readonly tradeValueMicro: bigint;
    readonly productDeclared: string | null;
    readonly raw: string | null;
  } | null;
}

function fill(value: unknown): PositionFill {
  const row = record(value);
  const side = row.side === 'BUY' || row.side === 'SELL' ? row.side : unexpected();
  const source =
    row.source === 'trade' || row.source === 'opening_lot' || row.source === 'corporate_action'
      ? row.source
      : unexpected();
  const trade = row.trade === null ? null : record(row.trade);
  return {
    allocationId: str(row.allocationId),
    side,
    quantity: big(row.quantity),
    valueMicro: big(row.valueMicro),
    bucket: str(row.bucket),
    inferred: bool(row.inferred),
    source,
    trade:
      trade === null
        ? null
        : {
            executedAtUtc: instant(trade.executedAtUtc),
            tradeDateIst: date(trade.tradeDateIst),
            exchange: str(trade.exchange),
            quantity: big(trade.quantity),
            priceMicro: big(trade.priceMicro),
            tradeValueMicro: big(trade.tradeValueMicro),
            productDeclared: strOrNull(trade.productDeclared),
            raw: strOrNull(trade.raw),
          },
  };
}

export interface PositionLot {
  readonly quantity: bigint;
  readonly entryValueMicro: bigint;
  readonly exitValueMicro: bigint | null;
  readonly entryDateIst: string;
  readonly exitDateIst: string | null;
}

function lot(value: unknown): PositionLot {
  const row = record(value);
  return {
    quantity: big(row.quantity),
    entryValueMicro: big(row.entryValueMicro),
    exitValueMicro: bigOrNull(row.exitValueMicro),
    entryDateIst: date(row.entryDateIst),
    exitDateIst: dateOrNull(row.exitDateIst),
  };
}

export interface PositionCharge {
  readonly allocationId: string;
  readonly component: string;
  readonly source: 'estimated' | 'reported';
  readonly amountMicro: bigint;
}

function charge(value: unknown): PositionCharge {
  const row = record(value);
  const source = row.source === 'estimated' || row.source === 'reported' ? row.source : unexpected();
  return {
    allocationId: str(row.allocationId),
    component: str(row.component),
    source,
    amountMicro: big(row.amountMicro),
  };
}

export interface JournalEntry {
  readonly id: string;
  readonly setupTagId: string | null;
  readonly mistakeTagIds: readonly string[];
  readonly thesis: string | null;
  readonly initialStopMicro: bigint | null;
  readonly plannedStopMicro: bigint | null;
  readonly plannedTargetMicro: bigint | null;
  readonly plannedRiskMicro: bigint | null;
  readonly reviewNote: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attachments: readonly { readonly id: string; readonly bytes: number }[];
}

function journalEntry(value: unknown): JournalEntry {
  const row = record(value);
  return {
    id: str(row.id),
    setupTagId: strOrNull(row.setupTagId),
    mistakeTagIds: list(row.mistakeTagIds).map(str),
    thesis: strOrNull(row.thesis),
    initialStopMicro: bigOrNull(row.initialStopMicro),
    plannedStopMicro: bigOrNull(row.plannedStopMicro),
    plannedTargetMicro: bigOrNull(row.plannedTargetMicro),
    plannedRiskMicro: bigOrNull(row.plannedRiskMicro),
    reviewNote: strOrNull(row.reviewNote),
    reviewedAt: instantOrNull(row.reviewedAt),
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
    attachments: list(row.attachments).map((entry) => {
      const attachment = record(entry);
      return { id: str(attachment.id), bytes: num(attachment.bytes) };
    }),
  };
}

export interface PositionDetail {
  readonly position: PositionSummary;
  readonly instruments: Readonly<Record<string, string>>;
  readonly fills: readonly PositionFill[];
  readonly lots: readonly PositionLot[];
  readonly charges: readonly PositionCharge[];
  readonly journal: readonly JournalEntry[];
}

export function positionDetail(body: unknown): PositionDetail {
  const value = record(body);
  return {
    position: positionSummary(value.position),
    instruments: names(value.instruments),
    fills: list(value.fills).map(fill),
    lots: list(value.lots).map(lot),
    charges: list(value.charges).map(charge),
    journal: list(value.journal).map(journalEntry),
  };
}

export const positionQuery = (ref: string) =>
  queryOptions({
    queryKey: ['positions', 'detail', ref],
    queryFn: async () =>
      positionDetail(await readJson(await send(() => api.positions[':ref'].$get({ param: { ref } })))),
  });

/** Marks a closed position reviewed, or reopens its review. */
export async function setReviewed(ref: string, reviewed: boolean): Promise<void> {
  const route = api.positions[':ref'][reviewed ? 'review' : 'reopen'];
  await readJson(await send(() => route.$post({ param: { ref } })));
}

/**
 * Where a position's P&L figures come from (direction §3), worst first: incomplete history, then a statement that
 * disagrees, then estimated charges; reconciled only when the statement covers everything.
 */
export function netProvenance(position: PositionSummary): ProvenanceKind {
  if (position.incomplete) return 'incomplete';
  if (position.feeStatus === 'FEES_DISCREPANCY') return 'discrepancy';
  if (position.feeStatus === 'FEES_RECONCILED') return 'reconciled';
  return 'estimated';
}

const CHARGE_ORDER = ['brokerage', 'stt', 'exchange_txn', 'sebi', 'ipft', 'stamp_duty', 'gst', 'dp'];

export interface ChargeLine {
  readonly component: string;
  /** Null when the fee engine estimated none of it (only a statement bills it). */
  readonly estimatedMicro: bigint | null;
  /** Null when no statement covers this charge for any of the fills. */
  readonly reportedMicro: bigint | null;
  /** What counts: reported where a statement covers a fill's charge, else estimated. */
  readonly effectiveMicro: bigint;
}

/** Per charge component, the estimate, the statement's amount and what counts (PRD §8.2), in a fixed order. */
export function chargeLines(charges: readonly PositionCharge[]): ChargeLine[] {
  const byKey = new Map<string, { component: string; estimated: bigint | null; reported: bigint | null }>();
  for (const entry of charges) {
    const key = `${entry.component}|${entry.allocationId}`;
    const current = byKey.get(key) ?? { component: entry.component, estimated: null, reported: null };
    byKey.set(
      key,
      entry.source === 'estimated'
        ? { ...current, estimated: (current.estimated ?? 0n) + entry.amountMicro }
        : { ...current, reported: (current.reported ?? 0n) + entry.amountMicro },
    );
  }
  const add = (a: bigint | null, b: bigint | null): bigint | null => (b === null ? a : (a ?? 0n) + b);
  const lines = new Map<string, ChargeLine>();
  for (const amounts of byKey.values()) {
    const line = lines.get(amounts.component);
    lines.set(amounts.component, {
      component: amounts.component,
      estimatedMicro: add(line?.estimatedMicro ?? null, amounts.estimated),
      reportedMicro: add(line?.reportedMicro ?? null, amounts.reported),
      effectiveMicro: (line?.effectiveMicro ?? 0n) + (amounts.reported ?? amounts.estimated ?? 0n),
    });
  }
  const rank = (component: string) => CHARGE_ORDER.indexOf(component) + 1 || CHARGE_ORDER.length + 1;
  return [...lines.values()].sort((a, b) => rank(a.component) - rank(b.component));
}

const REVIEW_ERRORS: Readonly<Record<string, string>> = {
  not_found: 'This position changed meanwhile (new trades rebuilt it). The list has been refreshed.',
  invalid: 'Only a closed position can be reviewed.',
};

export const reviewError = (error: unknown): string =>
  (error instanceof ApiError ? REVIEW_ERRORS[error.code] : undefined) ?? 'That did not work. Try again.';
