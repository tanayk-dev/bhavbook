// S10b-1 task 3: suspicion heuristics. Suggestions only (ADR-0015: never applied automatically).
import { describe, expect, it } from 'vitest';
import { reconstructAccount, suspectCorporateActions } from '../../src/index.js';
import { fill } from '../fifo/helpers.js';

describe('suspectCorporateActions', () => {
  it('(a) an orphan sell that is an integer multiple (>= 2) of the holding suggests a missed split or bonus', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 500, at: '2025-01-01 10:00', product: 'DELIVERY', instrument: 'X' }),
      fill({ side: 'SELL', qty: 50, price: 110, at: '2025-04-01 10:00', product: 'DELIVERY', instrument: 'X' }),
    ];
    const reconstruction = reconstructAccount(fills, []);
    expect(suspectCorporateActions(reconstruction)).toEqual([
      { kind: 'split_or_bonus', accountId: 'acc', instrumentKey: 'X', dateIst: '2025-04-01', multiple: 5n },
    ]);
  });

  it('(a) stays quiet for a plain orphan, a non-multiple, or a multiple below 2', () => {
    const cases = [
      [{ qty: 10, sell: 15 }],
      [{ qty: 10, sell: 10 }],
    ];
    for (const [entry] of cases) {
      const fills = [
        fill({ side: 'BUY', qty: entry?.qty ?? 0, price: 1, at: '2025-01-01 10:00', product: 'DELIVERY', instrument: 'X' }),
        fill({ side: 'SELL', qty: entry?.sell ?? 0, price: 1, at: '2025-04-01 10:00', product: 'DELIVERY', instrument: 'X' }),
      ];
      expect(suspectCorporateActions(reconstructAccount(fills, []))).toEqual([]);
    }
    const orphanOnly = [fill({ side: 'SELL', qty: 5, price: 1, at: '2025-04-01 10:00', product: 'DELIVERY', instrument: 'X' })];
    expect(suspectCorporateActions(reconstructAccount(orphanOnly, []))).toEqual([]);
  });

  it('(b) a holding that goes quiet while a new ISIN appears selling a related quantity suggests a conversion or demerger', () => {
    const fills = [
      fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY', instrument: 'OLD' }),
      fill({ side: 'SELL', qty: 20, price: 60, at: '2025-06-01 10:00', product: 'DELIVERY', instrument: 'NEW' }),
    ];
    expect(suspectCorporateActions(reconstructAccount(fills, []))).toEqual([
      { kind: 'conversion_or_demerger', accountId: 'acc', fromInstrument: 'OLD', toInstrument: 'NEW', dateIst: '2025-06-01' },
    ]);
  });

  it('(b) ignores new instruments that appear with an unrelated quantity, before the holding went quiet, or with a buy', () => {
    const base = fill({ side: 'BUY', qty: 10, price: 100, at: '2025-01-01 10:00', product: 'DELIVERY', instrument: 'OLD' });
    const later = fill({ side: 'BUY', qty: 1, price: 100, at: '2025-07-01 10:00', product: 'DELIVERY', instrument: 'OLD' });
    for (const other of [
      fill({ side: 'SELL', qty: 7, price: 60, at: '2025-06-01 10:00', product: 'DELIVERY', instrument: 'NEW' }),
      fill({ side: 'BUY', qty: 10, price: 60, at: '2025-06-01 10:00', product: 'DELIVERY', instrument: 'NEW' }),
    ]) {
      expect(suspectCorporateActions(reconstructAccount([base, other], []))).toEqual([]);
    }
    const early = fill({ side: 'SELL', qty: 10, price: 60, at: '2025-06-01 10:00', product: 'DELIVERY', instrument: 'NEW' });
    expect(suspectCorporateActions(reconstructAccount([base, later, early], [])).filter((entry) => entry.kind === 'conversion_or_demerger')).toEqual([]);
  });
});
