// S15a (PRD §9, ADR-0025): analytics over trades and realised lots, hand-computed. A trade is a CLOSED,
// non-excluded, complete position (incomplete ones only with the toggle). Breakeven is |net| ≤ the threshold and is
// left out of the win rate. R = net ÷ planned risk (the user's amount, else Σ |opening price − initial stop| × qty).
// Ratios are exact (bigint numerator and denominator); money is bigint micro-rupees.
import { describe, expect, it } from 'vitest';
import {
  apportionLotCharges,
  computeMetrics,
  costOfMistakes,
  formatRatio,
  NO_SETUP,
  plannedRiskOf,
  ratio,
  realisedBy,
  rMultiple,
  sliceTrades,
  tradeHoldingDays,
  type RealisedLot,
  type TradeFacts,
} from '../../src/index.js';

const RUPEE = 1_000_000n;
const OPTIONS = { breakevenMicro: 0n };

/** A closed trade (long, 10 bought for ₹1,000), changed by `overrides`. */
function trade(overrides: Partial<TradeFacts> = {}): TradeFacts {
  return {
    positionId: 'p',
    accountId: 'acc1',
    profileId: 'prof1',
    broker: 'dhan',
    bucket: 'DELIVERY',
    incomplete: false,
    excluded: false,
    openedDateIst: '2024-05-02',
    closedDateIst: '2024-05-10',
    grossMicro: 0n,
    chargesMicro: 0n,
    chargesEstimated: false,
    entries: [{ quantity: 10n, valueMicro: 1000n * RUPEE }],
    plannedRiskMicro: null,
    initialStopMicro: null,
    setupTag: null,
    mistakeTags: [],
    ...overrides,
  };
}

/** A closed trade with this net P&L (gross with no charges). */
const net = (rupees: bigint, overrides: Partial<TradeFacts> = {}) =>
  trade({ grossMicro: rupees * RUPEE, ...overrides });

describe('ratio and formatRatio', () => {
  it('is reduced, with the sign on the numerator', () => {
    expect(ratio(6n, -4n)).toEqual({ num: -3n, den: 2n });
    expect(ratio(0n, 5n)).toEqual({ num: 0n, den: 1n });
    expect(() => ratio(1n, 0n)).toThrow();
  });

  it('formats half-up in bigint, for any size and sign', () => {
    expect(formatRatio(ratio(2n, 3n), 2)).toBe('0.67');
    expect(formatRatio(ratio(-1n, 8n), 2)).toBe('-0.13');
    expect(formatRatio(ratio(7n, 2n), 0)).toBe('4');
    expect(formatRatio(ratio(10n ** 30n + 1n, 1n), 1)).toBe(`${(10n ** 30n + 1n).toString()}.0`);
    expect(() => formatRatio(ratio(1n, 1n), -1)).toThrow();
  });
});

describe('computeMetrics', () => {
  it('counts wins, losses and breakevens by net; win rate leaves breakevens out', () => {
    const metrics = computeMetrics(
      [net(300n), net(-100n), net(0n), net(200n, { chargesMicro: 50n * RUPEE })],
      OPTIONS,
    );
    expect(metrics).toMatchObject({ trades: 4, wins: 2, losses: 1, breakevens: 1 });
    expect([metrics.grossMicro, metrics.chargesMicro, metrics.netMicro]).toEqual([
      400n * RUPEE,
      50n * RUPEE,
      350n * RUPEE,
    ]);
    expect(metrics.winRate).toEqual(ratio(2n, 3n));
    // Expectancy is over every counted trade, breakevens included.
    expect(metrics.expectancy).toEqual(ratio(350n * RUPEE, 4n));
    expect(metrics.avgWinner).toEqual(ratio(450n * RUPEE, 2n));
    expect(metrics.avgLoser).toEqual(ratio(-100n * RUPEE, 1n));
    expect(metrics.profitFactor).toEqual(ratio(9n, 2n));
  });

  it('charges can turn a gross win into a net loss', () => {
    const metrics = computeMetrics([trade({ grossMicro: 10n * RUPEE, chargesMicro: 12n * RUPEE })], OPTIONS);
    expect(metrics).toMatchObject({ wins: 0, losses: 1 });
  });

  it('uses the breakeven threshold on net P&L; a negative threshold counts as 0', () => {
    const metrics = computeMetrics([net(5n), net(-5n), net(6n)], { breakevenMicro: 5n * RUPEE });
    expect(metrics).toMatchObject({ wins: 1, losses: 0, breakevens: 2 });
    expect(metrics.winRate).toEqual(ratio(1n, 1n));
    expect(metrics.avgLoser).toBeNull();
    const tiny = computeMetrics([trade({ grossMicro: 1n }), trade({ grossMicro: -1n })], {
      breakevenMicro: -RUPEE,
    });
    expect(tiny).toMatchObject({ wins: 1, losses: 1, breakevens: 0 });
  });

  it('has no rates without trades, "no losses" without losses, and none when all are breakeven', () => {
    const empty = computeMetrics([], OPTIONS);
    expect(empty).toMatchObject({
      trades: 0,
      winRate: null,
      expectancy: null,
      avgWinner: null,
      avgLoser: null,
      profitFactor: null,
      avgR: null,
      avgHoldingDays: null,
    });
    expect(computeMetrics([net(10n), net(20n)], OPTIONS).profitFactor).toBe('no_losses');
    const flat = computeMetrics([net(0n, { plannedRiskMicro: RUPEE }), net(0n)], OPTIONS);
    expect(flat).toMatchObject({ trades: 2, breakevens: 2, winRate: null, profitFactor: null });
    expect(flat.expectancy).toEqual(ratio(0n, 1n));
    expect(flat.avgR).toEqual(ratio(0n, 1n));
  });

  it('includes only closed, complete, non-excluded trades, and counts what it left out', () => {
    const metrics = computeMetrics(
      [
        net(10n),
        net(20n, { incomplete: true }),
        net(30n, { excluded: true }),
        net(40n, { excluded: true, incomplete: true }),
        trade({ closedDateIst: null }),
      ],
      OPTIONS,
    );
    expect(metrics.trades).toBe(1);
    expect(metrics.netMicro).toBe(10n * RUPEE);
    // Excluded-and-incomplete counts once, as excluded.
    expect(metrics.excluded).toEqual({ incomplete: 1, excluded: 2, noStop: 1 });
    const withIncomplete = computeMetrics([net(10n), net(20n, { incomplete: true })], {
      ...OPTIONS,
      includeIncomplete: true,
    });
    expect(withIncomplete.trades).toBe(2);
    expect(withIncomplete.excluded.incomplete).toBe(0);
  });

  it('is estimated when any counted trade has an estimated charge', () => {
    expect(computeMetrics([net(1n), net(2n, { chargesEstimated: true })], OPTIONS).estimated).toBe(true);
    expect(
      computeMetrics([net(1n), net(2n, { chargesEstimated: true, excluded: true })], OPTIONS).estimated,
    ).toBe(false);
  });

  it('averages R over trades with a planned risk, and counts the rest as "no stop"', () => {
    const metrics = computeMetrics(
      [
        net(200n, { plannedRiskMicro: 100n * RUPEE }),
        net(-50n, { plannedRiskMicro: 100n * RUPEE }),
        net(10n),
      ],
      OPTIONS,
    );
    expect(metrics.rTrades).toBe(2);
    expect(metrics.avgR).toEqual(ratio(3n, 4n));
    expect(metrics.excluded.noStop).toBe(1);
  });

  it('rounds each R to six decimals, so the average stays small over many distinct risks', () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      net(100n, { plannedRiskMicro: 3n * RUPEE + BigInt(index) * 7n + 1n }),
    );
    const { avgR } = computeMetrics(many, OPTIONS);
    expect(avgR?.den).toBeLessThanOrEqual(500n * 1_000_000n);
    // Mean of 100 ÷ (3 + (7i + 1)/10^6) rupees over i < 500 ≈ 33.333 × (1 − 1,747.5 / 3,000,000) ≈ 33.314.
    expect(formatRatio(avgR ?? ratio(0n, 1n), 2)).toBe('33.31');
    // One third of an R: 0.333333 after rounding.
    expect(computeMetrics([net(1n, { plannedRiskMicro: 3n * RUPEE })], OPTIONS).avgR).toEqual(
      ratio(333_333n, 1_000_000n),
    );
  });

  it('averages holding days', () => {
    const metrics = computeMetrics(
      [
        net(1n, { openedDateIst: '2024-05-02', closedDateIst: '2024-05-02' }),
        net(1n, { openedDateIst: '2024-02-28', closedDateIst: '2024-03-01' }),
      ],
      OPTIONS,
    );
    // 0 and 2 days (2024 is a leap year).
    expect(metrics.avgHoldingDays).toEqual(ratio(1n, 1n));
  });
});

describe('planned risk and R', () => {
  it("uses the user's amount first", () => {
    expect(plannedRiskOf(trade({ plannedRiskMicro: 500n * RUPEE, initialStopMicro: 90n * RUPEE }))).toBe(
      500n * RUPEE,
    );
  });

  it('else sums |opening price − initial stop| × qty over every opening fill (scale-ins add risk)', () => {
    const scaled = trade({
      entries: [
        { quantity: 10n, valueMicro: 1000n * RUPEE },
        { quantity: 5n, valueMicro: 550n * RUPEE },
      ],
      initialStopMicro: 95n * RUPEE,
    });
    // (100 − 95) × 10 + (110 − 95) × 5 = 50 + 75.
    expect(plannedRiskOf(scaled)).toBe(125n * RUPEE);
    expect(rMultiple({ ...scaled, grossMicro: 250n * RUPEE })).toEqual(ratio(2n, 1n));
    expect(rMultiple({ ...scaled, grossMicro: -125n * RUPEE })).toEqual(ratio(-1n, 1n));
  });

  it("a short's opening fills are its sells, with the stop above them", () => {
    const short = trade({
      entries: [{ quantity: 10n, valueMicro: 1000n * RUPEE }],
      initialStopMicro: 105n * RUPEE,
    });
    expect(plannedRiskOf(short)).toBe(50n * RUPEE);
    expect(rMultiple({ ...short, grossMicro: 100n * RUPEE })).toEqual(ratio(2n, 1n));
  });

  it('is undefined without a stop or an amount, or when the risk is zero or negative', () => {
    expect(rMultiple(trade())).toBeNull();
    expect(rMultiple(trade({ initialStopMicro: 100n * RUPEE }))).toBeNull();
    expect(rMultiple(trade({ plannedRiskMicro: 0n }))).toBeNull();
    expect(rMultiple(trade({ plannedRiskMicro: -RUPEE }))).toBeNull();
  });
});

describe('tradeHoldingDays', () => {
  it('counts IST calendar days from the first opening to the final closing fill; intraday is 0', () => {
    expect(tradeHoldingDays(trade({ openedDateIst: '2024-05-02', closedDateIst: '2024-05-02' }))).toBe(0);
    expect(tradeHoldingDays(trade({ openedDateIst: '2023-12-31', closedDateIst: '2024-03-01' }))).toBe(61);
  });

  it('never fails a dashboard: open is 0, and so are dates in the wrong order', () => {
    expect(tradeHoldingDays(trade({ closedDateIst: null }))).toBe(0);
    expect(tradeHoldingDays(trade({ openedDateIst: '2024-05-10', closedDateIst: '2024-05-02' }))).toBe(0);
  });
});

describe('slices', () => {
  it('slices by setup, profile, account, broker, bucket and exit month', () => {
    const trades = [
      net(10n, { setupTag: 'Breakout', closedDateIst: '2024-05-31' }),
      net(-5n, { setupTag: 'Breakout', bucket: 'INTRADAY', closedDateIst: '2024-06-01' }),
      net(7n, { broker: 'zerodha', accountId: 'acc2', profileId: 'prof2' }),
      trade({ closedDateIst: null, setupTag: 'Open' }),
    ];
    const bySetup = sliceTrades(trades, 'setup', OPTIONS);
    expect([...bySetup.keys()]).toEqual(['Breakout', NO_SETUP, 'Open']);
    expect(bySetup.get('Breakout')?.netMicro).toBe(5n * RUPEE);
    expect(bySetup.get('Open')?.trades).toBe(0);
    expect([...sliceTrades(trades, 'month', OPTIONS).keys()]).toEqual(['2024-05', '2024-06']);
    expect(sliceTrades(trades, 'broker', OPTIONS).get('zerodha')?.trades).toBe(1);
    expect(sliceTrades(trades, 'bucket', OPTIONS).get('INTRADAY')?.losses).toBe(1);
    expect([...sliceTrades(trades, 'profile', OPTIONS).keys()]).toEqual(['prof1', 'prof2']);
    expect([...sliceTrades(trades, 'account', OPTIONS).keys()]).toEqual(['acc1', 'acc2']);
  });

  it('a trade with two mistakes counts in both, once each; untagged trades are in none', () => {
    const trades = [
      net(-100n, { mistakeTags: ['FOMO', 'Moved stop', 'FOMO'] }),
      net(-50n, { mistakeTags: ['FOMO'], incomplete: true }),
      net(30n),
    ];
    const byMistake = sliceTrades(trades, 'mistake', OPTIONS);
    expect([...byMistake.keys()]).toEqual(['FOMO', 'Moved stop']);
    expect(byMistake.get('FOMO')).toMatchObject({
      trades: 1,
      excluded: { incomplete: 1, excluded: 0, noStop: 1 },
    });
    const withIncomplete = sliceTrades(trades, 'mistake', { ...OPTIONS, includeIncomplete: true });
    expect(withIncomplete.get('FOMO')?.netMicro).toBe(-150n * RUPEE);
    expect(costOfMistakes(trades, OPTIONS)).toEqual(
      new Map([
        ['FOMO', { trades: 1, netMicro: -100n * RUPEE }],
        ['Moved stop', { trades: 1, netMicro: -100n * RUPEE }],
      ]),
    );
  });
});

describe('realisation views', () => {
  const lot = (exitDateIst: string, grossMicro: bigint, chargesMicro = 0n): RealisedLot => ({
    positionId: 'p',
    exitDateIst,
    grossMicro,
    chargesMicro,
  });

  it('count partial exits in the month and on the day they happened, in date order', () => {
    const lots = [lot('2024-06-03', -40n), lot('2024-05-31', 100n, 10n), lot('2024-06-03', 5n, 1n)];
    expect(realisedBy(lots, 'month')).toEqual(
      new Map([
        ['2024-05', { lots: 1, grossMicro: 100n, chargesMicro: 10n, netMicro: 90n }],
        ['2024-06', { lots: 2, grossMicro: -35n, chargesMicro: 1n, netMicro: -36n }],
      ]),
    );
    expect([...realisedBy(lots, 'day').keys()]).toEqual(['2024-05-31', '2024-06-03']);
  });

  it("apportion each allocation's charges over its lots by quantity, exactly", () => {
    const result = apportionLotCharges(
      new Map([
        ['buy', 10n],
        ['sell1', 3n],
        ['sell2', -4n],
        ['orphan', 7n],
      ]),
      [
        { lotKey: 'l1', entry: 'buy', exit: 'sell1', quantity: 1n },
        { lotKey: 'l2', entry: 'buy', exit: 'sell2', quantity: 1n },
        { lotKey: 'l3', entry: 'buy', exit: null, quantity: 1n },
      ],
    );
    // buy's 10 over 1:1:1 → 4, 3, 3 (largest remainder); a refund splits the same way; the orphan's 7 has no lot.
    expect(result.shares).toEqual(
      new Map([
        ['l1', 7n],
        ['l2', -1n],
        ['l3', 3n],
      ]),
    );
    expect(result.unallocatedMicro).toBe(7n);
    const total = [...result.shares.values()].reduce((sum, part) => sum + part, 0n) + result.unallocatedMicro;
    expect(total).toBe(16n);
  });
});
