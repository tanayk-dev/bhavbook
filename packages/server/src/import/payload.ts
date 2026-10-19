// batch_row payloads (schema 0002): each batch's own canonical copy of its rows, used by undo (S7-2) to re-insert
// rows another batch shares. Trade payloads drop the raw text (raw_row holds it, found by batch + line) and keep
// bigints as exact decimal strings; decoding restores them exactly. Statement data is kept as JSON text: money
// and text fields are both strings there, and statement_row.data_json is that same text.
import {
  canonicalRowSchema,
  statementRowSchema,
  type CanonicalRow,
  type StatementRow,
} from '@bhavbook/adapters';
import { z } from 'zod';
import { toJson } from '../http/json.js';

export type TradePayload = Omit<CanonicalRow, 'raw'> & { readonly raw: { readonly line: number } };

const integerText = z.string().regex(/^\d{1,20}$/);

const tradePayloadSchema = canonicalRowSchema.extend({
  quantity: integerText.transform(BigInt).pipe(z.bigint().positive()),
  priceMicro: integerText.transform(BigInt),
  tradeValueMicro: integerText.transform(BigInt),
  raw: z.object({ line: z.number().int().positive() }).strict(),
});

const statementPayloadSchema = statementRowSchema.extend({
  data: z.record(z.string(), z.union([z.string(), z.null()])),
});

export function encodeTradePayload(row: CanonicalRow): string {
  return toJson({ ...row, raw: { line: row.raw.line } });
}

export function decodeTradePayload(json: string): TradePayload {
  return tradePayloadSchema.parse(JSON.parse(json));
}

export function encodeStatementPayload(row: StatementRow): string {
  return toJson(row);
}

/** The statement as stored: `dataJson` is exactly what statement_row.data_json holds for it. */
export function decodeStatementPayload(
  json: string,
): Omit<StatementRow, 'data'> & { readonly dataJson: string } {
  const { data, ...rest } = statementPayloadSchema.parse(JSON.parse(json));
  return { ...rest, dataJson: JSON.stringify(data) };
}
