// S15b-2: the dashboard on the Overview page against a stubbed server, through the real router. The charts are
// stubbed here (ECharts needs a real browser; the E2E draws them): what is checked is the numbers, the tables, the
// filters in the URL and the empty states.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { axisRupees, calendarWindows, signed } from '@/components/charts/labels';
import { analyticsOf, dashboardFilterOf, percent } from '@/lib/analytics';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

vi.mock('@/components/charts/pnl-charts', () => ({
  EquityChart: () => <div role="img" aria-label="Equity curve (stub)" />,
  MonthlyChart: () => <div role="img" aria-label="Monthly (stub)" />,
  CalendarChart: () => <div role="img" aria-label="Calendar (stub)" />,
}));

const metrics = (overrides: Record<string, unknown> = {}) => ({
  trades: 7,
  wins: 4,
  losses: 3,
  breakevens: 0,
  grossMicro: '12000000000',
  chargesMicro: '500000000',
  netMicro: '11500000000',
  estimated: true,
  winRate: { num: '4', den: '7' },
  expectancy: { num: '11500000000', den: '7' },
  avgWinner: { num: '5000000000', den: '1' },
  avgLoser: { num: '-2833333333', den: '1' },
  profitFactor: { num: '20', den: '17' },
  avgR: { num: '37', den: '20' },
  rTrades: 5,
  avgHoldingDays: { num: '9', den: '2' },
  excluded: { incomplete: 2, excluded: 1, noStop: 2 },
  ...overrides,
});

const BODY = {
  breakevenMicro: '0',
  includeIncomplete: false,
  includedIncomplete: 0,
  summary: metrics(),
  days: [
    { date: '2025-09-04', lots: 1, netMicro: '18250000000', cumulativeMicro: '18250000000' },
    { date: '2025-10-06', lots: 1, netMicro: '-6750000000', cumulativeMicro: '11500000000' },
  ],
  months: [
    {
      month: '2025-09',
      lots: 1,
      grossMicro: '20000000000',
      chargesMicro: '1750000000',
      netMicro: '18250000000',
    },
    {
      month: '2025-10',
      lots: 1,
      grossMicro: '-6500000000',
      chargesMicro: '250000000',
      netMicro: '-6750000000',
    },
  ],
  bySetup: [
    { tag: 'Breakout', metrics: metrics({ trades: 4 }) },
    { tag: null, metrics: metrics({ trades: 3, winRate: null, expectancy: null, avgR: null }) },
  ],
  byMistake: [{ tag: 'Late exit', metrics: metrics({ trades: 2 }) }],
  mistakeCost: [{ tag: 'Late exit', trades: 2, netMicro: '-1000000000' }],
};

const EMPTY = { ...BODY, summary: metrics({ trades: 0 }), days: [], months: [], bySetup: [], byMistake: [] };

function server(body: unknown = BODY) {
  const queries: string[] = [];
  const routes: Routes = {
    'GET /api/vault': { body: { schemaVersion: 5 } },
    'GET /api/profiles': {
      body: {
        profiles: [
          { id: 'p1', name: 'Swing', accounts: [{ id: 'a1', broker: 'zerodha', nickname: 'Z main' }] },
          { id: 'p2', name: 'Long term', accounts: [{ id: 'a2', broker: 'dhan', nickname: 'D main' }] },
        ],
      },
    },
    'GET /api/issues/summary': { body: { open: 0, byKind: {} } },
    'GET /api/positions/review-count': { body: { count: 0 } },
    'GET /api/analytics': (_body, url) => {
      queries.push(url.search);
      return { body };
    },
  };
  return { routes, queries };
}

function renderAt(path: string, routes: Routes) {
  stubServer(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the dashboard', () => {
  it('checks the response and keeps only valid filters', () => {
    expect(analyticsOf(BODY).summary.winRate).toEqual({ num: 4n, den: 7n });
    expect(() => analyticsOf({ ...BODY, summary: metrics({ netMicro: 1.5 }) })).toThrow(ApiError);
    expect(percent({ num: 4n, den: 7n })).toBe('57.1%');
    expect(
      dashboardFilterOf({
        broker: 'dhan',
        bucket: 'FNO',
        from: '2025-01-01',
        to: '2025-13',
        includeIncomplete: 'true',
        x: 1,
      }),
    ).toEqual({ broker: 'dhan', from: '2025-01-01', includeIncomplete: true });
    expect(dashboardFilterOf({ profileId: '', includeIncomplete: false })).toEqual({});
    // Dates and months reach chart tooltips: anything else is refused.
    expect(() => analyticsOf({ ...BODY, days: [{ ...BODY.days[0], date: '<img src=x>' }] })).toThrow(
      ApiError,
    );
    expect(() => analyticsOf({ ...BODY, months: [{ ...BODY.months[0], month: '2025-9' }] })).toThrow(
      ApiError,
    );
  });

  it('labels amounts and spans the calendar over the data, a year per row at most', () => {
    expect(signed(1_240_500_000n)).toBe('▲ +₹1,240.50');
    expect(signed(-312_400_000n)).toBe('▼ −₹312.40');
    expect(signed(0n)).toBe('₹0.00');
    expect(axisRupees(-5000)).toBe('−₹5,000');
    expect(axisRupees(1200000)).toBe('₹12,00,000');
    const day = (date: string) => ({ date, lots: 1, netMicro: 0n, cumulativeMicro: 0n });
    expect(calendarWindows([])).toEqual([]);
    expect(calendarWindows([day('2024-04-23'), day('2025-01-06')])).toEqual([['2024-04-23', '2025-01-06']]);
    expect(calendarWindows([day('2024-02-29'), day('2026-03-01')])).toEqual([
      ['2024-02-29', '2025-02-28'],
      ['2025-03-01', '2026-02-28'],
      ['2026-03-01', '2026-03-01'],
    ]);
  });
});

describe('the dashboard', () => {
  it('shows the metrics strip with what was left out, the charts with their tables, and the slices', async () => {
    const { routes } = server();
    renderAt('/', routes);
    const strip = await screen.findByRole('region', { name: 'Metrics' });
    const figure = (label: string) => within(strip).getByText(label).nextElementSibling;
    expect(figure('Net P&L')).toHaveTextContent('+₹11,500.00');
    expect(within(strip).getByRole('img', { name: 'Estimated by the fee engine' })).toBeInTheDocument();
    expect(figure('Win rate')).toHaveTextContent('57.1%');
    expect(figure('Expectancy')).toHaveTextContent('+₹1,642.86');
    expect(figure('Profit factor')).toHaveTextContent('1.18');
    expect(figure('Average R')).toHaveTextContent('1.85R');
    expect(figure('Trades')).toHaveTextContent('7');
    expect(figure('Without a stop')).toHaveTextContent('2');
    expect(strip).toHaveTextContent('Left out: 2 incomplete positions and 1 excluded position.');
    expect(await screen.findByRole('img', { name: 'Equity curve (stub)' })).toBeInTheDocument();
    const months = screen.getByRole('table', { name: 'Realised P&L by month' });
    expect(within(months).getByRole('row', { name: /Oct 2025/ })).toHaveTextContent(
      /−₹6,500\.00.*₹250\.00.*−₹6,750\.00/,
    );
    const setups = screen.getByRole('table', { name: 'Trades by setup' });
    expect(within(setups).getByRole('row', { name: /Breakout/ })).toHaveTextContent('4');
    expect(within(setups).getByRole('row', { name: /None/ })).toHaveTextContent('—');
    expect(screen.getByRole('table', { name: 'Trades by mistake' })).toHaveTextContent('Late exit');
  });

  it('keeps the filters in the URL and asks for them', async () => {
    const { routes, queries } = server();
    const router = renderAt('/?broker=dhan', routes);
    expect(await screen.findByLabelText('Broker')).toHaveValue('dhan');
    await waitFor(() => {
      expect(queries.at(-1)).toContain('broker=dhan');
    });
    await userEvent.selectOptions(screen.getByLabelText('Product'), 'INTRADAY');
    await userEvent.click(screen.getByLabelText('Include incomplete positions'));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({
        broker: 'dhan',
        bucket: 'INTRADAY',
        includeIncomplete: true,
      });
    });
    await waitFor(() => {
      expect(queries.at(-1)).toMatch(/bucket=INTRADAY/);
    });
    expect(queries.at(-1)).toMatch(/includeIncomplete=true/);
    // Choosing a profile narrows the accounts offered.
    await userEvent.selectOptions(screen.getByLabelText('Profile'), 'p2');
    expect(within(screen.getByLabelText('Account')).queryByRole('option', { name: 'Z main' })).toBeNull();
  });

  it('marks the net ◐ when incomplete positions are included, and says how many', async () => {
    const { routes } = server({
      ...BODY,
      includeIncomplete: true,
      includedIncomplete: 2,
      summary: metrics({ excluded: { incomplete: 0, excluded: 0, noStop: 2 } }),
    });
    renderAt('/?includeIncomplete=true', routes);
    const strip = await screen.findByRole('region', { name: 'Metrics' });
    expect(within(strip).getByRole('img', { name: 'Incomplete history' })).toBeInTheDocument();
    expect(strip).toHaveTextContent('Included: 2 incomplete positions (◐), whose history is missing trades.');
    expect(screen.getByText(/The charts count realised P&L on the day it happened/)).toBeInTheDocument();
  });

  it('drops an account of another broker when the broker changes', async () => {
    const { routes } = server();
    const router = renderAt('/?accountId=a1', routes);
    await userEvent.selectOptions(await screen.findByLabelText('Broker'), 'dhan');
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ broker: 'dhan' });
    });
  });

  it('says there are no trades yet', async () => {
    const { routes } = server(EMPTY);
    renderAt('/', routes);
    expect(await screen.findByText('No trades yet')).toBeInTheDocument();
    expect(screen.queryByRole('search', { name: 'Filter the dashboard' })).toBeNull();
  });

  it('keeps the filters when a filtered view is empty', async () => {
    const { routes } = server(EMPTY);
    renderAt('/?from=2030-01-01', routes);
    expect(await screen.findByText('No realised P&L in this range.')).toBeInTheDocument();
    expect(screen.getByRole('search', { name: 'Filter the dashboard' })).toBeInTheDocument();
  });
});
