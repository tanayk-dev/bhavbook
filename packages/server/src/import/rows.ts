// The trade_row / statement_row inserts, shared by commit (from parsed files) and undo (from batch_row copies).
// Both keep the first row per dedup key (ADR-0009).
import type { CanonicalRow } from '@bhavbook/adapters';
import type { TradePayload } from './payload.js';

export const INSERT_TRADE_SQL = `INSERT INTO trade_row (account_id, batch_id, raw_row_id, dedup_key, granularity, source,
    external_order_id, executed_at_utc, trade_date_ist, side, quantity, price_micro, trade_value_micro,
    value_authority, exchange, isin, broker_symbol, broker_name, product_declared, flags_json)
  VALUES (@accountId, @batchId, @rawRowId, @dedupKey, @granularity, @source, @externalOrderId, @executedAtUtc,
    @tradeDateIst, @side, @quantity, @priceMicro, @tradeValueMicro, @valueAuthority, @exchange, @isin,
    @brokerSymbol, @brokerName, @productDeclared, @flags)
  ON CONFLICT (account_id, dedup_key) DO NOTHING`;

export const INSERT_STATEMENT_SQL = `INSERT INTO statement_row (account_id, batch_id, kind, dedup_key, key_json, data_json)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (account_id, kind, dedup_key) DO NOTHING`;

/** Named parameters for INSERT_TRADE_SQL. */
export function tradeParams(
  accountId: string,
  batchId: string,
  rawRowId: unknown,
  row: CanonicalRow | TradePayload,
): Record<string, unknown> {
  return {
    accountId,
    batchId,
    rawRowId,
    dedupKey: row.dedupKey,
    granularity: row.granularity,
    source: row.source,
    externalOrderId: row.externalOrderId,
    executedAtUtc: row.executedAtUtc,
    tradeDateIst: row.tradeDateIst,
    side: row.side,
    quantity: row.quantity,
    priceMicro: row.priceMicro,
    tradeValueMicro: row.tradeValueMicro,
    valueAuthority: row.valueAuthority,
    exchange: row.exchange,
    isin: row.isin,
    brokerSymbol: row.brokerSymbol,
    brokerName: row.brokerName,
    productDeclared: row.productDeclared,
    flags: JSON.stringify(row.flags),
  };
}
