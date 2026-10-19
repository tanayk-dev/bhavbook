// The broker adapter contract (ADR-0008, PRD §6). Adapters are pure: they get file text or already-parsed sheet
// data and return canonical rows. They never do I/O and never see the vault. Types are inferred from the zod schemas
// so the runtime checks and the compile-time types can't drift apart.
import { z } from 'zod';

export const brokerIdSchema = z.enum(['zerodha', 'dhan']);
export type BrokerId = z.infer<typeof brokerIdSchema>;

/** `<broker>.<report>`, e.g. `zerodha.tradebook`, `dhan.trade_history`. */
export const reportKindSchema = z.string().regex(/^[a-z]+\.[a-z0-9_]+$/);
export type ReportKind = z.infer<typeof reportKindSchema>;

const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const utcInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/);
const micro = z.bigint().nonnegative();
const line = z.number().int().positive();

/** One cell of a parsed spreadsheet: cached values only, never formulas. */
export const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Cell = z.infer<typeof cellSchema>;

export const sheetDataSchema = z.object({ name: z.string(), rows: z.array(z.array(cellSchema)) });
export type SheetData = z.infer<typeof sheetDataSchema>;

/** What detect() sees: the start of a text file, or sheet names plus their first rows. */
export type FileProbe =
  | { readonly type: 'text'; readonly head: string }
  | { readonly type: 'sheets'; readonly sheets: readonly SheetData[] };

/** What parse() gets: the whole text file, or every sheet. */
export type AdapterInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'sheets'; readonly sheets: readonly SheetData[] };

export const canonicalRowSchema = z
  .object({
    /** Per-adapter idempotency key (ADR-0009); unique within an account. */
    dedupKey: z.string().min(1),
    granularity: z.enum(['fill', 'order']),
    source: z.enum(['tradebook', 'external']),
    externalOrderId: z.string().min(1).nullable(),
    executedAtUtc: utcInstant,
    tradeDateIst: istDate,
    side: z.enum(['BUY', 'SELL']),
    quantity: z.bigint().positive(),
    priceMicro: micro,
    tradeValueMicro: micro,
    /** Which money field is the broker's truth (ADR-0008): Zerodha `price`, Dhan `value`. */
    valueAuthority: z.enum(['price', 'value']),
    exchange: z.enum(['NSE', 'BSE']),
    isin: isin.nullable(),
    brokerSymbol: z.string().min(1).nullable(),
    brokerName: z.string().min(1).nullable(),
    productDeclared: z.enum(['DELIVERY', 'INTRADAY', 'MTF']).nullable(),
    flags: z.record(z.string(), z.boolean()),
    /** The original row, for the immutable raw store (ADR-0007). */
    raw: z.object({ line, text: z.string() }).strict(),
  })
  .strict();
export type CanonicalRow = z.infer<typeof canonicalRowSchema>;

export const statementRowSchema = z
  .object({
    /** e.g. `dhan.gt.row`, `dhan.tax.lot`, `zerodha.tax_pnl.lot`. */
    kind: z.string().regex(/^[a-z]+\.[a-z0-9_.]+$/),
    dedupKey: z.string().min(1),
    key: z.record(z.string(), z.string()),
    /** Money as micro-rupee bigints; other values as strings or null. */
    data: z.record(z.string(), z.union([z.bigint(), z.string(), z.null()])),
    line,
  })
  .strict();
export type StatementRow = z.infer<typeof statementRowSchema>;

export const instrumentHintSchema = z.object({ name: z.string().min(1), isin, line }).strict();
export type InstrumentHint = z.infer<typeof instrumentHintSchema>;

export const skipReasonSchema = z.enum(['fno', 'currency', 'commodity', 'mf', 'not_traded', 'other']);
export type SkipReason = z.infer<typeof skipReasonSchema>;

/** Errors carry a line and a code, never a cell value (ADR-0019). */
export const rowErrorSchema = z.object({ line, code: z.string().regex(/^[a-z_]+$/) }).strict();
export type RowError = z.infer<typeof rowErrorSchema>;

export const parseResultSchema = z
  .object({
    rows: z.array(canonicalRowSchema),
    statements: z.array(statementRowSchema),
    instrumentHints: z.array(instrumentHintSchema),
    skipped: z.array(z.object({ line, reason: skipReasonSchema }).strict()),
    errors: z.array(rowErrorSchema),
    coverage: z.object({ from: istDate, to: istDate }).strict().nullable(),
  })
  .strict();
export type ParseResult = z.infer<typeof parseResultSchema>;

export interface Detection {
  readonly kind: ReportKind;
  /** 0..1; 1 means the file's exact header was recognised. */
  readonly confidence: number;
}

/** A report the adapter recognises but v1 does not import, with the message shown to the user. */
export interface RejectedKind {
  readonly kind: ReportKind;
  readonly message: string;
}

export interface BrokerAdapter {
  readonly broker: BrokerId;
  /** Bumped whenever parsing output changes; stored on each import batch. */
  readonly version: string;
  readonly reportKinds: readonly ReportKind[];
  readonly rejectedKinds: readonly RejectedKind[];
  detect(probe: FileProbe): Detection | null;
  parse(input: AdapterInput, kind: ReportKind): ParseResult;
}
