// S12a task 5 golden: Dhan FY 2024-25 Global Transactions (the anonymised fixture). Each (date, scrip) row is
// rebuilt as one buy order and one sell order; the engine's charges are compared with what Dhan billed:
// STT and stamp duty per day (the rupee-rounded contract-note total), every other component per row within
// +/- Rs 0.01. 18 Sep 2024 needs the IPO opening lot (S10a) and is checked in S12b. One known residual: GST on
// 9 May 2024 (Jain Irrigation) is Rs 0.02 over; the row's odd-paise value suggests several fills, so S12a-2 checks
// it again with the real orders from the trade file.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allocateBuckets,
  bundledFeeRules,
  computeCharges,
  parseDecimalToMicro,
  type ChargeableFill,
  type ChargeComponent,
  type FillCharge,
} from '../../src/index.js';

const DIR = new URL('../../../adapters/fixtures/dhan/global_transactions/', import.meta.url);
const PAISA = 10_000n;
const RUPEE = 1_000_000n;
const SKIPPED_DAY = '2024-09-18';
const KNOWN_GST_RESIDUAL = '2024-05-09 Jain Irrigation Systems';
const MONTHS: Readonly<Record<string, string>> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

interface Row {
  readonly date: string;
  readonly scrip: string;
  readonly buyQty: bigint;
  readonly buyValue: bigint;
  readonly sellQty: bigint;
  readonly sellValue: bigint;
  readonly billed: Readonly<
    Record<'brokerage' | 'gst' | 'stt' | 'sebi' | 'stamp_duty' | 'exchange_txn' | 'ipft', bigint>
  >;
}

function readRows(): Row[] {
  const [name = ''] = readdirSync(DIR);
  const lines = readFileSync(new URL(name, DIR), 'utf8').split(/\r?\n/);
  return lines
    .filter((line) => /^"\d{2} [A-Z][a-z]{2} \d{4}/.test(line))
    .map((line) => {
      const cells = line.slice(1, -1).split('","');
      const [dateText = '', scrip = ''] = cells;
      const [day = '', month = '', year = ''] = dateText.split(' ');
      const money = (index: number): bigint => parseDecimalToMicro(cells[index] ?? '');
      return {
        date: `${year}-${MONTHS[month] ?? ''}-${day}`,
        scrip,
        buyQty: BigInt(cells[4] ?? ''),
        buyValue: money(5),
        sellQty: BigInt(cells[6] ?? ''),
        sellValue: money(7),
        billed: {
          brokerage: money(8),
          gst: money(9),
          stt: money(10),
          sebi: money(11),
          stamp_duty: money(12),
          exchange_txn: money(13),
          ipft: money(14),
        },
      };
    });
}

function fillsOf(rows: readonly Row[]): ChargeableFill[] {
  return rows.flatMap((row, index) => {
    const side = (
      kind: 'BUY' | 'SELL',
      quantity: bigint,
      valueMicro: bigint,
      time: string,
    ): ChargeableFill[] =>
      quantity === 0n
        ? []
        : [
            {
              id: `${String(index)}${kind[0] ?? ''}`,
              accountId: 'acc',
              instrumentKey: row.scrip,
              dedupKey: `${row.date}|${row.scrip}|${kind}`,
              executedAtUtc: `${row.date}T${time}Z`,
              tradeDateIst: row.date,
              side: kind,
              quantity,
              valueMicro,
              productDeclared: 'DELIVERY',
              granularity: 'order',
              externalOrderId: null,
              exchange: 'NSE',
            },
          ];
    return [
      ...side('BUY', row.buyQty, row.buyValue, '04:00:00'),
      ...side('SELL', row.sellQty, row.sellValue, '06:00:00'),
    ];
  });
}

const rows = readRows().filter((row) => row.date !== SKIPPED_DAY);
const fills = fillsOf(rows);
const { charges } = computeCharges({
  broker: 'dhan',
  fills,
  allocations: allocateBuckets(fills, []),
  rules: bundledFeeRules(),
});

function engineTotal(component: ChargeComponent, keep: (charge: FillCharge) => boolean): bigint {
  return charges
    .filter((entry) => entry.component === component && keep(entry))
    .reduce((sum, entry) => sum + entry.amountMicro, 0n);
}

const fillsOfRow = (row: Row): Set<string> =>
  new Set(
    fills
      .filter((entry) => entry.tradeDateIst === row.date && entry.instrumentKey === row.scrip)
      .map((entry) => entry.id),
  );
const ofFills =
  (ids: ReadonlySet<string>) =>
  (entry: FillCharge): boolean =>
    ids.has(entry.allocationKey.split('#')[0] ?? '');

describe('Dhan FY 2024-25 Global Transactions', () => {
  it('reads the fixture (one row per scrip per day)', () => {
    expect(rows).toHaveLength(79);
  });

  const days = [...new Set(rows.map((row) => row.date))];
  it.each(days)('%s: STT and stamp duty equal the day total Dhan billed (to the rupee)', (day) => {
    const ofDay = rows.filter((row) => row.date === day);
    const ids = new Set(ofDay.flatMap((row) => [...fillsOfRow(row)]));
    for (const component of ['stt', 'stamp_duty'] as const) {
      const billed = ofDay.reduce((sum, row) => sum + row.billed[component], 0n);
      const billedRupees = ((billed + RUPEE / 2n) / RUPEE) * RUPEE;
      expect([component, engineTotal(component, ofFills(ids))]).toEqual([component, billedRupees]);
    }
  });

  it.each(rows.map((row) => [`${row.date} ${row.scrip}`, row] as const))(
    '%s: brokerage, txn, SEBI, IPFT and GST within Rs 0.01 of the row',
    (_, row) => {
      const keep = ofFills(fillsOfRow(row));
      for (const component of ['brokerage', 'exchange_txn', 'sebi', 'ipft', 'gst'] as const) {
        const difference = engineTotal(component, keep) - row.billed[component];
        if (component === 'gst' && `${row.date} ${row.scrip}` === KNOWN_GST_RESIDUAL) {
          expect(difference).toBe(2n * PAISA);
          continue;
        }
        expect([component, difference <= PAISA && difference >= -PAISA]).toEqual([component, true]);
      }
    },
  );
});
