// S12a task 1: fee-rule files (zod schema), sources on every rate, version selection by trade date.
import { describe, expect, it } from 'vitest';
import { bundledFeeRules, FeeRuleError, parseFeeRules, selectFeeRules } from '../../src/index.js';
import nse20241001 from '../../rules/statutory/nse/2024-10-01.json' with { type: 'json' };

describe('bundled rule files', () => {
  it('parse, and every rate names its source and when it was checked', () => {
    const rules = bundledFeeRules();
    expect(rules.statutory.map((rule) => rule.id)).toEqual([
      'bse/2024-10-01',
      'nse/2024-04-01',
      'nse/2024-10-01',
      'nse/2026-03-01',
    ]);
    expect(rules.broker.map((rule) => rule.id)).toEqual(['dhan/2024-04-01', 'zerodha/2024-04-01', 'zerodha/2024-06-01']);
    const text = JSON.stringify(nse20241001);
    expect(text.match(/"value"/g)?.length).toBe(text.match(/"source_url":"https:\/\//g)?.length);
  });
});

describe('selectFeeRules', () => {
  const rules = bundledFeeRules();
  it.each([
    ['2024-09-30', 'NSE', 'nse/2024-04-01'],
    ['2024-10-01', 'NSE', 'nse/2024-10-01'],
    ['2026-02-28', 'NSE', 'nse/2024-10-01'],
    ['2026-03-01', 'NSE', 'nse/2026-03-01'],
    ['2025-12-01', 'BSE', 'bse/2024-10-01'],
  ] as const)('on %s picks the %s version in force', (date, exchange, id) => {
    expect(selectFeeRules(rules, 'dhan', exchange, date)?.statutory.id).toBe(id);
  });

  it('picks the broker version in force (Zerodha DP before and after 2024-06-01)', () => {
    expect(selectFeeRules(rules, 'zerodha', 'NSE', '2024-05-31')?.broker.id).toBe('zerodha/2024-04-01');
    expect(selectFeeRules(rules, 'zerodha', 'NSE', '2024-06-01')?.broker.id).toBe('zerodha/2024-06-01');
  });

  it('has nothing before the first version', () => {
    expect(selectFeeRules(rules, 'dhan', 'NSE', '2024-03-31')).toBeNull();
    expect(selectFeeRules(rules, 'dhan', 'BSE', '2024-09-30')).toBeNull();
  });
});

describe('parseFeeRules', () => {
  const good = structuredClone(nse20241001) as Record<string, unknown>;
  it.each<[string, (file: Record<string, unknown>) => unknown]>([
    ['a rate without a source', (file) => ({ ...file, sebi: { value: '0.0001%', verified_on: '2026-10-20' } })],
    ['a rate that is not a percentage', (file) => ({ ...file, sebi: { ...(file.sebi as object), value: '0.0001' } })],
    ['an http source', (file) => ({ ...file, sebi: { ...(file.sebi as object), source_url: 'http://x' } })],
    ['a bad effective date', (file) => ({ ...file, effective_from: '2024-13-01' })],
    ['an unknown field', (file) => ({ ...file, extra: 1 })],
    ['an unknown exchange', (file) => ({ ...file, exchange: 'MCX' })],
  ])('rejects %s', (_, mutate) => {
    expect(() => parseFeeRules([mutate(good)])).toThrow(FeeRuleError);
  });

  it('rejects two versions with the same effective date', () => {
    expect(() => parseFeeRules([good, good])).toThrow(FeeRuleError);
  });
});
