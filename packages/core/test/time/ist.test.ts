import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatIstDate,
  holdingDays,
  istDateOf,
  istDayBounds,
  parseIstLocal,
} from '../../src/time/index.js';
import { ParseError } from '../../src/errors.js';

describe('the test environment', () => {
  it('runs outside IST so machine-timezone bugs surface', () => {
    expect(process.env.TZ).toBe('America/New_York');
    expect(new Date('2025-01-15T12:00:00Z').getTimezoneOffset()).toBe(300);
  });
});

describe('parseIstLocal', () => {
  it.each([
    ['2025-09-12T14:50:01', '2025-09-12T09:20:01Z'],
    ['2025-09-12 09:15:00', '2025-09-12T03:45:00Z'],
    ['2025-09-12T02:00:00', '2025-09-11T20:30:00Z'],
    ['2025-09-12', '2025-09-11T18:30:00Z'],
    ['2024-02-29T23:59:59', '2024-02-29T18:29:59Z'],
  ])('treats %s as IST -> %s', (input, expected) => {
    expect(parseIstLocal(input)).toBe(expected);
  });

  it.each(['2025-02-30T10:00:00', '2025-9-12', '2025-09-12T25:00:00', '2025-09-12T10:60:00', '', 'soon'])(
    'rejects %j',
    (input) => {
      expect(() => parseIstLocal(input)).toThrow(ParseError);
    },
  );
});

describe('istDateOf', () => {
  it.each([
    ['2025-09-11T18:30:00Z', '2025-09-12'],
    ['2025-09-11T18:29:59Z', '2025-09-11'],
    ['2025-09-11T18:30:00.000Z', '2025-09-12'],
  ])('maps %s to IST date %s', (input, expected) => {
    expect(istDateOf(input)).toBe(expected);
  });

  it.each(['2025-09-11T18:30:00', 'not a date', '2025-13-01T00:00:00Z'])('rejects %j', (input) => {
    expect(() => istDateOf(input)).toThrow(ParseError);
  });

  it('inverts parseIstLocal for every instant (property)', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true }), (date) => {
        const ist = new Date(date.getTime() + 330 * 60_000);
        const day = ist.toISOString().slice(0, 10);
        const local = `${day}T${ist.toISOString().slice(11, 19)}`;
        const utc = parseIstLocal(local);
        expect(istDateOf(utc)).toBe(day);
        expect(utc).toBe(`${new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().slice(0, 19)}Z`);
      }),
    );
  });
});

describe('istDayBounds', () => {
  it('returns the UTC start (inclusive) and end (exclusive) of an IST day', () => {
    expect(istDayBounds('2025-09-12')).toEqual({
      startUtc: '2025-09-11T18:30:00Z',
      endUtc: '2025-09-12T18:30:00Z',
    });
  });

  it('rejects an invalid date', () => {
    expect(() => istDayBounds('2025-02-30')).toThrow(ParseError);
  });
});

describe('holdingDays', () => {
  it.each([
    ['2024-09-17', '2024-09-18', 1],
    ['2024-09-18', '2024-09-18', 0],
    ['2024-02-28', '2024-03-01', 2],
    ['2024-04-01', '2025-04-01', 365],
  ])('from %s to %s is %i days', (entry, exit, days) => {
    expect(holdingDays(entry, exit)).toBe(days);
  });

  it('rejects an exit before the entry', () => {
    expect(() => holdingDays('2024-09-18', '2024-09-17')).toThrow(RangeError);
  });
});

describe('formatIstDate', () => {
  it.each([
    ['2025-09-12', '12 Sep 2025'],
    ['2024-01-01', '01 Jan 2024'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatIstDate(input)).toBe(expected);
  });

  it('rejects an invalid date', () => {
    expect(() => formatIstDate('2024-13-01')).toThrow(ParseError);
  });
});
