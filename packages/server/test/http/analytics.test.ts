// S15b-1: the dashboard's analytics over HTTP. Golden: on the Dhan fixtures, FY 2024-25 realised gross by month is
// Dhan's own P&L report minus its three known paise (S15a). Semantics on made-up trades: wins and losses by net,
// charges, R from the journal's stop, setup and mistake slices, filters, incomplete and excluded positions, and
// partial exits dated when they happened. A benchmark: a 20,000-row vault answers under 300 ms.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDhanPnl } from '../../../adapters/test/golden/dhan-pnl.js';
import { recompute } from '../../src/recompute/index.js';
import { analytics } from '../../src/services/analytics.js';
import { DHAN, FIXTURES, fixtureFile, importFiles, withVault, ZERODHA } from '../import/helpers.js';
import { send, testApp, type TestApp } from './helpers.js';

const HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';
const TCS = 'INE467B01029';
const INFY = 'INE009A01021';

let tradeId = 0;
function trade(
  symbol: string,
  isin: string,
  side: 'buy' | 'sell',
  qty: number,
  price: number,
  date: string,
): string {
  tradeId += 1;
  const id = String(tradeId);
  return `${symbol},${isin},${date},NSE,EQ,EQ,${side},false,${String(qty)},${String(price)},${id},${id},${date}T10:00:00`;
}

const tradebook = (rows: readonly string[]) => ({ bytes: Buffer.from([HEADER, ...rows].join('\r\n')) });

interface Body {
  summary: {
    trades: number;
    wins: number;
    losses: number;
    grossMicro: string;
    chargesMicro: string;
    netMicro: string;
    winRate: { num: string; den: string } | null;
    avgR: { num: string; den: string } | null;
    rTrades: number;
    excluded: { incomplete: number; excluded: number; noStop: number };
  };
  days: { date: string; netMicro: string; cumulativeMicro: string }[];
  months: { month: string; grossMicro: string; netMicro: string }[];
  bySetup: { tag: string | null; metrics: { trades: number } }[];
  byMistake: { tag: string; metrics: { trades: number } }[];
  mistakeCost: { tag: string; trades: number; netMicro: string }[];
}

async function get(test: TestApp, filter = ''): Promise<Body> {
  const response = await send(test, `/api/analytics${filter}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
}

describe('golden: the dashboard on the Dhan fixtures', () => {
  it("FY 2024-25 realised gross by month is Dhan's P&L report minus its three known paise", async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, DHAN, [
        fixtureFile('dhan', 'trade_history'),
        fixtureFile('dhan', 'global_transactions'),
        fixtureFile('dhan', 'dp_charges'),
        fixtureFile('dhan', 'tax_report', 'tax.xls'),
      ]);
      recompute(db, DHAN);
      const body = await get(testApp({}, db), '?from=2024-04-01&to=2025-03-31&includeIncomplete=true');
      const gross = body.months.reduce((sum, month) => sum + BigInt(month.grossMicro), 0n);
      const report = readDhanPnl(
        readFileSync(path.join(FIXTURES, 'dhan', 'pnl', 'Dhan_P&L_01-04-2024_31-03-2025.csv'), 'utf8'),
      );
      expect(gross - report.grossMicro).toBe(-30_000n);
      expect(
        body.months.map((month) => month.month).every((month) => month >= '2024-04' && month <= '2025-03'),
      ).toBe(true);
      // The curve ends at the months' net.
      const net = body.months.reduce((sum, month) => sum + BigInt(month.netMicro), 0n);
      expect(BigInt(body.days.at(-1)?.cumulativeMicro ?? '0')).toBe(net);
    });
  });
});

describe('metrics on made-up trades', () => {
  it('counts wins and losses by net, R from the stop, slices by setup and mistake, and filters', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [
        tradebook([
          trade('TCS', TCS, 'buy', 10, 100, '2025-09-01'),
          trade('TCS', TCS, 'sell', 10, 120, '2025-09-04'),
          trade('INFY', INFY, 'buy', 10, 100, '2025-09-02'),
          trade('INFY', INFY, 'sell', 10, 90, '2025-10-06'),
        ]),
      ]);
      recompute(db, ZERODHA);
      const test = testApp({}, db);
      db.prepare(
        "INSERT INTO tag (id, kind, name) VALUES ('t_bo', 'setup', 'Breakout'), ('t_late', 'mistake', 'Late exit')",
      ).run();
      const tcs = db.prepare('SELECT id FROM position WHERE instrument_key = ?').pluck().get(TCS) as string;
      const ref = Buffer.from(tcs).toString('base64url');
      const saved = await send(test, `/api/positions/${ref}/journal`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupTagId: 't_bo',
          mistakeTagIds: ['t_late'],
          thesis: null,
          initialStopMicro: '95000000',
          plannedStopMicro: null,
          plannedTargetMicro: null,
          plannedRiskMicro: null,
          reviewNote: null,
        }),
      });
      expect(saved.status).toBe(200);

      const all = await get(test);
      expect(all.summary).toMatchObject({
        trades: 2,
        wins: 1,
        losses: 1,
        grossMicro: '100000000',
        rTrades: 1,
      });
      expect(all.summary.winRate).toEqual({ num: '1', den: '2' });
      expect(BigInt(all.summary.netMicro)).toBe(100_000_000n - BigInt(all.summary.chargesMicro));
      expect(all.summary.excluded).toEqual({ incomplete: 0, excluded: 0, noStop: 1 });
      // TCS: risk |100 − 95| × 10 = ₹50, so R is its net ÷ ₹50 (to the millionth core rounds each R to). TCS is the
      // only trade tagged "Late exit", so that mistake's cost is its net.
      const r = all.summary.avgR;
      if (r === null) throw new Error('no R');
      const tcsNet = BigInt(all.mistakeCost[0]?.netMicro ?? '0');
      expect(Math.abs(Number(r.num) / Number(r.den) - Number(tcsNet) / 50_000_000)).toBeLessThan(1e-6);
      // Most trades first, then by name (no setup sorts first).
      expect(all.bySetup.map((slice) => [slice.tag, slice.metrics.trades])).toEqual([
        [null, 1],
        ['Breakout', 1],
      ]);
      // The same effective charges the positions list sums (EFFECTIVE_CHARGES_SQL): reported where covered.
      const listed = (await (await send(test, '/api/positions?state=CLOSED')).json()) as {
        positions: { chargesMicro: string }[];
      };
      expect(listed.positions.reduce((sum, position) => sum + BigInt(position.chargesMicro), 0n)).toBe(
        BigInt(all.summary.chargesMicro),
      );
      expect(all.byMistake.map((slice) => slice.tag)).toEqual(['Late exit']);
      expect(all.mistakeCost).toEqual([expect.objectContaining({ tag: 'Late exit', trades: 1 })]);
      expect(all.months.map((month) => month.month)).toEqual(['2025-09', '2025-10']);

      // The cache follows writes: retagging the trade moves it to another setup at once.
      db.prepare("INSERT INTO tag (id, kind, name) VALUES ('t_pb', 'setup', 'Pullback')").run();
      db.prepare("UPDATE journal_entry SET setup_tag_id = 't_pb'").run();
      expect((await get(test)).bySetup.map((slice) => slice.tag)).toEqual([null, 'Pullback']);

      expect((await get(test, '?broker=dhan')).summary.trades).toBe(0);
      expect((await get(test, '?from=2025-10-01')).summary.trades).toBe(1);
      expect((await get(test, '?to=2025-09-30')).months.map((month) => month.month)).toEqual(['2025-09']);
      expect((await get(test, '?profileId=prof1&bucket=DELIVERY')).summary.trades).toBe(2);
      for (const bad of ['?bucket=FNO', '?from=2025-1-1', '?includeIncomplete=yes', '?sort=x']) {
        expect((await send(test, `/api/analytics${bad}`)).status).toBe(400);
      }
    });
  });

  it('leaves incomplete positions out unless asked, never excluded ones, and dates partial exits', async () => {
    await withVault(async ({ db, service }) => {
      await importFiles(service, ZERODHA, [
        tradebook([
          // An orphan sell: INCOMPLETE.
          trade('TCS', TCS, 'sell', 5, 120, '2025-09-04'),
          // Bought 10, sold 4 so far: open, with a realised partial exit.
          trade('INFY', INFY, 'buy', 10, 100, '2025-09-02'),
          trade('INFY', INFY, 'sell', 4, 110, '2025-09-10'),
        ]),
      ]);
      recompute(db, ZERODHA);
      const test = testApp({}, db);
      const plain = await get(test);
      expect(plain.summary.trades).toBe(0);
      expect(plain.summary.excluded.incomplete).toBe(1);
      // The partial exit is realised on its day: 4 × (110 − 100) before charges.
      expect(plain.days.map((day) => day.date)).toEqual(['2025-09-10']);
      expect(BigInt(plain.months[0]?.grossMicro ?? '0')).toBe(40_000_000n);

      // A date range keeps the open position's partial exit in its day, and the open position out of the trades.
      const ranged = await get(test, '?from=2025-09-05&to=2025-09-30');
      expect(ranged.summary.trades).toBe(0);
      expect(ranged.summary.excluded.incomplete).toBe(0);
      expect(ranged.days.map((day) => day.date)).toEqual(['2025-09-10']);

      const withIncomplete = await get(test, '?includeIncomplete=true');
      expect(withIncomplete.summary.trades).toBe(1);
      expect((withIncomplete as unknown as { includedIncomplete: number }).includedIncomplete).toBe(1);
      expect((plain as unknown as { includedIncomplete: number }).includedIncomplete).toBe(0);
      expect(withIncomplete.days.map((day) => day.date)).toEqual(['2025-09-10']);

      const anchor = db
        .prepare('SELECT anchor_key FROM position WHERE instrument_key = ?')
        .pluck()
        .get(TCS) as string;
      expect(
        (
          await send(test, `/api/accounts/${ZERODHA}/adjustments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'exclude', anchorKey: anchor }),
          })
        ).status,
      ).toBe(201);
      const excluded = await get(test, '?includeIncomplete=true');
      expect(excluded.summary.trades).toBe(0);
      expect(excluded.summary.excluded.excluded).toBe(1);
    });
  });
});

describe('performance', () => {
  it(
    'answers on a 20,000-row vault in under 300 ms (once its facts are built)',
    { timeout: 600_000 },
    async () => {
      const isins = [
        ...new Set(
          fixtureFile('zerodha', 'tradebook')
            .bytes.toString('utf8')
            .split(/\r?\n/)
            .slice(1)
            .map((line) => line.split(',')[1] ?? '')
            .filter((isin) => /^IN[A-Z0-9]{9}\d$/.test(isin)),
        ),
      ];
      expect(isins.length).toBeGreaterThan(10);
      await withVault(async ({ db, service }) => {
        const rows: string[] = [];
        // 10,000 round trips (20,000 rows) over two years of trading days, spread over the fixture's ISINs.
        const start = Date.parse('2024-04-01T00:00:00Z');
        for (let n = 0; n < 10_000; n += 1) {
          const isin = isins[n % isins.length] ?? TCS;
          const buy = new Date(start + Math.floor(n / isins.length) * 2 * 86_400_000)
            .toISOString()
            .slice(0, 10);
          const sell = new Date(Date.parse(buy) + 86_400_000).toISOString().slice(0, 10);
          rows.push(
            trade('SYM', isin, 'buy', 10, 100 + (n % 7), buy),
            trade('SYM', isin, 'sell', 10, 100 + (n % 11), sell),
          );
        }
        await importFiles(service, ZERODHA, [tradebook(rows)]);
        recompute(db, ZERODHA);
        expect(db.prepare('SELECT count(*) FROM trade_row').pluck().get()).toBe(20_000n);
        // The first answer builds the vault's facts (about 0.35 s alone; loosely bounded, as coverage and parallel files
        // slow it); later ones, whatever the filter, reuse them until a write: those are held to 300 ms.
        const cold = performance.now();
        analytics(db);
        expect(performance.now() - cold).toBeLessThan(5_000);
        analytics(db, { broker: 'zerodha' });
        const times: number[] = [];
        for (const filter of [
          '',
          '?broker=zerodha',
          '?from=2024-06-01&to=2025-03-31',
          '?bucket=DELIVERY&includeIncomplete=true',
        ]) {
          const started = performance.now();
          const body = await get(testApp({}, db), filter);
          times.push(performance.now() - started);
          expect(body.summary.trades).toBeGreaterThan(0);
          if (filter.startsWith('?from')) {
            // The range narrows: no realised day outside it.
            expect(body.days.every((day) => day.date >= '2024-06-01' && day.date <= '2025-03-31')).toBe(true);
          }
        }
        times.sort((a, b) => a - b);
        expect(times[Math.floor(times.length / 2)]).toBeLessThan(300);
      });
    },
  );
});
