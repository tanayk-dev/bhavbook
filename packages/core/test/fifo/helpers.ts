// Builders for reconstruction tests: fills in rupees, read back in micro-rupees.
import type { Bucket, TradeFill } from '../../src/index.js';

export const RUPEE = 1_000_000n;

let counter = 0;

export interface FillSpec {
  readonly side: 'BUY' | 'SELL';
  readonly qty: number;
  /** Price in whole rupees or a decimal string ("173.50"). */
  readonly price: number | string;
  readonly at: string;
  readonly account?: string;
  readonly instrument?: string;
  readonly product?: Bucket | null;
  readonly order?: string;
  readonly granularity?: 'fill' | 'order';
}

function micro(price: number | string): bigint {
  const [whole = '0', fraction = ''] = String(price).split('.');
  return BigInt(whole) * RUPEE + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

/** A fill at an IST wall-clock time `YYYY-MM-DD HH:MM[:SS]`. */
export function fill(spec: FillSpec): TradeFill {
  counter += 1;
  const [date = '', time = '00:00'] = spec.at.split(' ');
  const [hours = '0', minutes = '0', seconds = '0'] = time.split(':');
  const utc = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(hours), Number(minutes), Number(seconds)) -
      330 * 60_000,
  )
    .toISOString()
    .replace('.000Z', 'Z');
  const quantity = BigInt(spec.qty);
  return {
    id: `f${String(counter).padStart(4, '0')}`,
    accountId: spec.account ?? 'acc',
    instrumentKey: spec.instrument ?? 'INE000000001',
    dedupKey: `k${String(counter).padStart(4, '0')}`,
    executedAtUtc: utc,
    tradeDateIst: date,
    side: spec.side,
    quantity,
    valueMicro: quantity * micro(spec.price),
    productDeclared: spec.product === undefined ? null : spec.product,
    granularity: spec.granularity ?? 'fill',
    externalOrderId: spec.order ?? null,
  };
}

export function rupees(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  const paise = magnitude % RUPEE;
  return `${sign}${String(magnitude / RUPEE)}${paise === 0n ? '' : `.${paise.toString().padStart(6, '0').replace(/0+$/, '')}`}`;
}
