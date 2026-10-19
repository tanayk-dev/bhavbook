// batch_row payloads must round-trip exactly, so S7-2's undo can re-insert rows from them.
import { zerodhaAdapter, type BrokerAdapter, type ParseResult } from '@bhavbook/adapters';
import { describe, expect, it } from 'vitest';
import { decodeStatementPayload, decodeTradePayload } from '../../src/import/index.js';
import { DHAN, fixtureFile, importFiles, withVault, ZERODHA } from './helpers.js';

describe('batch_row payloads', () => {
  it('decode every trade copy back to the stored trade_row values, bigints exact', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
      await importFiles(service, DHAN, [fixtureFile('dhan', 'trade_history')]);
      const rows = db
        .prepare(
          `SELECT b.payload_json, t.quantity, t.price_micro, t.trade_value_micro, t.executed_at_utc, r.line_no
           FROM batch_row b
           JOIN trade_row t ON t.batch_id = b.batch_id AND t.dedup_key = b.dedup_key
           JOIN raw_row r ON r.id = t.raw_row_id
           WHERE b.target = 'trade'`,
        )
        .all() as {
        payload_json: string;
        quantity: bigint;
        price_micro: bigint;
        trade_value_micro: bigint;
        executed_at_utc: string;
        line_no: bigint;
      }[];
      expect(rows).toHaveLength(237);
      for (const row of rows) {
        const payload = decodeTradePayload(row.payload_json);
        expect(payload.quantity).toBe(row.quantity);
        expect(payload.priceMicro).toBe(row.price_micro);
        expect(payload.tradeValueMicro).toBe(row.trade_value_micro);
        expect(payload.executedAtUtc).toBe(row.executed_at_utc);
        expect(BigInt(payload.raw.line)).toBe(row.line_no);
      }
    });
  });

  it('decode statement copies to exactly the stored data_json', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [
        fixtureFile('dhan', 'global_transactions'),
        fixtureFile('dhan', 'dp_charges'),
      ]);
      const rows = db
        .prepare(
          `SELECT b.payload_json, s.data_json, s.key_json FROM batch_row b
           JOIN statement_row s ON s.batch_id = b.batch_id AND s.kind = b.kind AND s.dedup_key = b.dedup_key
           WHERE b.target = 'statement'`,
        )
        .all() as { payload_json: string; data_json: string; key_json: string }[];
      expect(rows.length).toBeGreaterThan(80);
      for (const row of rows) {
        const payload = decodeStatementPayload(row.payload_json);
        expect(payload.dataJson).toBe(row.data_json);
        expect(JSON.stringify(payload.key)).toBe(row.key_json);
      }
    });
  });
});

describe('contract checks at preview', () => {
  it('treats a parse result with repeated dedup keys as malformed instead of failing at commit', async () => {
    const repeating: BrokerAdapter = {
      ...zerodhaAdapter,
      parse: (input, kind): ParseResult => {
        const result = zerodhaAdapter.parse(input, kind);
        const [first] = result.rows;
        return first
          ? { ...result, rows: [first, { ...first, raw: { ...first.raw, line: 9_999 } }] }
          : result;
      },
    };
    await withVault(
      async ({ service }) => {
        const preview = await service.previewImport(ZERODHA, [fixtureFile('zerodha', 'tradebook')]);
        expect(preview.files[0]).toMatchObject({ status: 'unreadable', reason: 'malformed' });
        expect(preview.token).toBeNull();
      },
      { adapters: [repeating] },
    );
  });
});
