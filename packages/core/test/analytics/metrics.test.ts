// S15a (PRD §9, ADR-0025): analytics over trades and realised lots, hand-computed. A trade is a CLOSED,
// non-excluded, complete position (incomplete ones only with the toggle). Breakeven is |net| ≤ the threshold and is
// left out of the win rate. R = net ÷ planned risk (the user's amount, else Σ |entry price − initial stop| × qty).
// Ratios are exact (bigint numerator and denominator); money is bigint micro-rupees.
import { describe, expect, it } from 'vitest';
import {
  apportionLotCharges,
  computeMetrics,
  costOfMistakes,
  holdingDays,
  plannedRiskMicro,
  ratio,
  realisedBy,
  rMultiple,
  sliceTrades,
  type RealisedLot,
  type TradeFacts,
} from '../../src/index.js';

const RUPEE = 1_000_000n;
const OPTIONS = { breakevenMicro: 0n };

let next = 0;
function trade(overrides: Partial<TradeFacts> = {}): TradeFacts {
  next += 1;
  return {
    positionId: `p${String(next)}`,
    accountId: 'acc1',
    profileId: 'prof1',
    broker: 'dhan',
    bucket: 'DELIVERY',
    closed: true,
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

describe('ratio', () => {
  it('is reduced, with the sign on the numerator', () => {
    expect(ratio(6n, -4n)).toEqual({ num: -3n, den: 2n });
    expect(ratio(0n, 5n)).toEqual({ num: 0n, den: 1n });
    expect(() => ratio(1n, 0n)).toThrow();
  });
});

describe('computeMetrics', () => {
  it('counts wins, losses and breakevens; win rate leaves breakevens out', () => {
    const metrics = computeMetrics(
      [net(300n), net(-100n), net(0n), net(200n, { chargesMicro: 50n * RUPEE })],
      OPTIONS,
    );
    expect(metrics).toMatchObject({ trades: 4, wins: 2, losses: 1, breakevens: 1 });
    expect(metrics.grossMicro).toBe(400n * RUPEE);
    expect(metrics.chargesMicro).toBe(50n * RUPEE);
    expect(metrics.netMicro).toBe(350n * RUPEE);
    expect(metrics.winRate).toEqual(ratio(2n, 3n));
    expect(metrics.expectancyMicro).toEqual(ratio(350n * RUPEE, 4n));
    expect(metrics.avgWinnerMicro).toEqual(ratio(450n * RUPEE, 2n));
    expect(metrics.avgLoserMicro).toEqual(ratio(-100n * RUPEE, 1n));
    expect(metrics.profitFactor).toEqual(ratio(450n, 100n));
  });

  it('uses the breakeven threshold on net P&L', () => {
    const metrics = computeMetrics([net(5n), net(-5n), net(6n)], { breakevenMicro: 5n * RUPEE });
    expect(metrics).toMatchObject({ wins: 1, losses: 0, breakevens: 2 });
    expect(metrics.winRate).toEqual(ratio(1n, 1n));
  });

  it('has no rates without trades, "no losses" without losses, and none when all are breakeven', () => {
    const empty = computeMetrics([], OPTIONS);
    expect(empty).toMatchObject({
      trades: 0,
      winRate: null,
      expectancyMicro: null,
      profitFactor: null,
      avgR: null,
    });
    expect(computeMetrics([net(10n), net(20n)], OPTIONS).profitFactor).toBe('no_losses');
    const flat = computeMetrics([net(0n), net(0n)], OPTIONS);
    expect(flat).toMatchObject({ trades: 2, breakevens: 2, winRate: null, profitFactor: null });
    expect(flat.expectancyMicro).toEqual(ratio(0n, 1n));
  });

  it('includes only closed, complete, non-excluded trades, and counts what it left out', () => {
    const metrics = computeMetrics(
      [
        net(10n),
        net(20n, { incomplete: true }),
        net(30n, { excluded: true }),
        net(40n, { excluded: true, incomplete: true }),
        trade({ closed: false, closedDateIst: null }),
      ],
      OPTIONS,
    );
    expect(metrics.trades).toBe(1);
    expect(metrics.netMicro).toBe(10n * RUPEE);
    expect(metrics.excluded).toEqual({ incomplete: 1, excluded: 2, noStop: 1 });
    const withIncomplete = computeMetrics([net(10n), net(20n, { incomplete: true })], {
      ...OPTIONS,
      includeIncomplete: true,
    });
    expect(withIncomplete.trades).toBe(2);
    expect(withIncomplete.excluded.incomplete).toBe(0);
  });

  it('is estimated when any included trade has an estimated charge', () => {
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

  it('averages holding days', () => {
    const metrics = computeMetrics(
      [
        net(1n, { openedDateIst: '2024-05-02', closedDateIst: '2024-05-02' }),
        net(1n, { openedDateIst: '2024-02-28', closedDateIst: '2024-03-01' }),
      ],
      OPTIONS,
    );
    expect(metrics.avgHoldingDays).toEqual(ratio(2n, 2n));
  });
});

describe('planned risk and R', () => {
  it("uses the user's amount first", () => {
    expect(plannedRiskMicro(trade({ plannedRiskMicro: 500n * RUPEE, initialStopMicro: 90n * RUPEE }))).toBe(
      500n * RUPEE,
    );
  });

  it('else sums |entry price − initial stop| × qty over every entry (scale-ins add risk)', () => {
    const scaled = trade({
      entries: [
        { quantity: 10n, valueMicro: 1000n * RUPEE },
        { quantity: 5n, valueMicro: 550n * RUPEE },
      ],
      initialStopMicro: 95n * RUPEE,
    });
    // (100 − 95) × 10 + (110 − 95) × 5 = 50 + 75.
    expect(plannedRiskMicro(scaled)).toBe(125n * RUPEE);
    expect(rMultiple({ ...scaled, grossMicro: 250n * RUPEE })).toEqual(ratio(2n, 1n));
  });

  it("a short's stop sits above the entry; the distance is the same", () => {
    expect(plannedRiskMicro(trade({ initialStopMicro: 105n * RUPEE }))).toBe(50n * RUPEE);
  });

  it('is undefined without a stop or an amount, or when the risk is zero', () => {
    expect(rMultiple(trade())).toBeNull();
    expect(rMultiple(trade({ initialStopMicro: 100n * RUPEE }))).toBeNull();
  });
});

describe('holdingDays', () => {
  it('counts IST calendar days from the first entry to the final exit; intraday is 0', () => {
    expect(holdingDays(trade({ openedDateIst: '2024-05-02', closedDateIst: '2024-05-02' }))).toBe(0);
    expect(holdingDays(trade({ openedDateIst: '2023-12-31', closedDateIst: '2024-03-01' }))).toBe(61);
  });
});

describe('slices', () => {
  it('slices by setup, profile, account, broker, bucket and exit month', () => {
    const trades = [
      net(10n, { setupTag: 'Breakout', closedDateIst: '2024-05-31' }),
      net(-5n, { setupTag: 'Breakout', bucket: 'INTRADAY', closedDateIst: '2024-06-01' }),
      net(7n, { broker: 'zerodha', accountId: 'acc2', profileId: 'prof2' }),
    ];
    const bySetup = sliceTrades(trades, 'setup', OPTIONS);
    expect([...bySetup.keys()]).toEqual(['Breakout', '(none)']);
    expect(bySetup.get('Breakout')?.netMicro).toBe(5n * RUPEE);
    expect([...sliceTrades(trades, 'month', OPTIONS).keys()]).toEqual(['2024-05', '2024-06']);
    expect(sliceTrades(trades, 'broker', OPTIONS).get('zerodha')?.trades).toBe(1);
    expect(sliceTrades(trades, 'bucket', OPTIONS).get('INTRADAY')?.losses).toBe(1);
    expect([...sliceTrades(trades, 'profile', OPTIONS).keys()]).toEqual(['prof1', 'prof2']);
    expect([...sliceTrades(trades, 'account', OPTIONS).keys()]).toEqual(['acc1', 'acc2']);
  });

  it('a trade with two mistakes counts in both; excluded counts go with each slice', () => {
    const trades = [
      net(-100n, { mistakeTags: ['FOMO', 'Moved stop'] }),
      net(-50n, { mistakeTags: ['FOMO'], incomplete: true }),
    ];
    const byMistake = sliceTrades(trades, 'mistake', OPTIONS);
    expect(byMistake.get('FOMO')).toMatchObject({
      trades: 1,
      excluded: { incomplete: 1, excluded: 0, noStop: 1 },
    });
    expect(byMistake.get('Moved stop')?.netMicro).toBe(-100n * RUPEE);
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

  it('count partial exits in the month and day they happened', () => {
    const lots = [lot('2024-05-31', 100n, 10n), lot('2024-06-03', -40n), lot('2024-06-03', 5n, 1n)];
    expect(realisedBy(lots, 'month')).toEqual(
      new Map([
        ['2024-05', { lots: 1, grossMicro: 100n, chargesMicro: 10n, netMicro: 90n }],
        ['2024-06', { lots: 2, grossMicro: -35n, chargesMicro: 1n, netMicro: -36n }],
      ]),
    );
    expect([...realisedBy(lots, 'day').keys()]).toEqual(['2024-05-31', '2024-06-03']);
  });

  it("apportion each allocation's charges over its lots by quantity, exactly", () => {
    const shares = apportionLotCharges(
      new Map([
        ['buy', 10n],
        ['sell1', 3n],
        ['sell2', 4n],
      ]),
      [
        { lotKey: 'l1', entry: 'buy', exit: 'sell1', quantity: 3n },
        { lotKey: 'l2', entry: 'buy', exit: 'sell2', quantity: 4n },
        { lotKey: 'l3', entry: 'buy', exit: null, quantity: 3n },
      ],
    );
    // buy's 10 over 3:4:3 → 3, 4, 3; each sell's charges go to its one lot.
    expect(shares).toEqual(
      new Map([
        ['l1', 6n],
        ['l2', 8n],
        ['l3', 3n],
      ]),
    );
  });
});
