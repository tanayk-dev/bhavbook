// S14a-3a: the review queue and the position detail, against a stubbed server through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { chargeLines, positionDetail, positionList } from '@/lib/positions';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const TCS = 'INE467B01029';
const INFY = 'INE009A01021';

function summary(ref: string, instrumentKey: string, overrides: Record<string, unknown> = {}) {
  return {
    ref,
    accountId: 'a1',
    accountNickname: 'Z main',
    broker: 'zerodha',
    instrumentKey,
    bucket: 'DELIVERY',
    state: 'CLOSED',
    incomplete: false,
    excluded: false,
    orphanQty: '0',
    openedAtUtc: '2025-09-12T04:30:00.000Z',
    closedAtUtc: '2025-09-15T05:30:00.000Z',
    openQty: '0',
    boughtQty: '10',
    boughtValueMicro: '1000000000',
    soldValueMicro: '1200000000',
    realisedGrossMicro: '200000000',
    chargesMicro: '2500000',
    feeStatus: 'FEES_ESTIMATED',
    reviewedAt: null,
    journalEntries: 0,
    ...overrides,
  };
}

const DETAIL = {
  position: summary('cmVmVENT', TCS, { feeStatus: 'FEES_DISCREPANCY' }),
  instruments: { [TCS]: 'TCS' },
  fills: [
    {
      allocationId: '1',
      side: 'BUY',
      quantity: '10',
      valueMicro: '1000000000',
      bucket: 'DELIVERY',
      inferred: true,
      source: 'trade',
      trade: {
        executedAtUtc: '2025-09-12T04:30:00.000Z',
        tradeDateIst: '2025-09-12',
        exchange: 'NSE',
        quantity: '10',
        priceMicro: '100000000',
        tradeValueMicro: '1000000000',
        valueAuthority: 'price',
        productDeclared: null,
        raw: 'TCS,INE467B01029,2025-09-12,NSE,EQ,EQ,buy,false,10,100,1,10,2025-09-12T10:00:00',
      },
    },
    {
      allocationId: '2',
      side: 'SELL',
      quantity: '10',
      valueMicro: '1200000000',
      bucket: 'DELIVERY',
      inferred: false,
      source: 'trade',
      trade: {
        executedAtUtc: '2025-09-15T05:30:00.000Z',
        tradeDateIst: '2025-09-15',
        exchange: 'BSE',
        quantity: '10',
        priceMicro: '120000000',
        tradeValueMicro: '1200000000',
        valueAuthority: 'price',
        productDeclared: 'DELIVERY',
        raw: null,
      },
    },
  ],
  lots: [
    {
      entryAllocationId: '1',
      exitAllocationId: '2',
      quantity: '10',
      entryValueMicro: '1000000000',
      exitValueMicro: '1200000000',
      entryDateIst: '2025-09-12',
      exitDateIst: '2025-09-15',
    },
  ],
  charges: [
    { allocationId: '1', component: 'stt', source: 'estimated', amountMicro: '1000000', ruleVersion: 'x' },
    { allocationId: '1', component: 'stt', source: 'reported', amountMicro: '1100000', ruleVersion: null },
    { allocationId: '2', component: 'stt', source: 'estimated', amountMicro: '1200000', ruleVersion: 'x' },
    { allocationId: '1', component: 'brokerage', source: 'estimated', amountMicro: '0', ruleVersion: 'x' },
  ],
  feeDiscrepancies: [],
  journal: [],
};

function server() {
  const state = {
    queue: [summary('cmVmVENT', TCS), summary('cmVmSU5GWQ', INFY, { realisedGrossMicro: '-500000000' })],
    reviewed: [] as ReturnType<typeof summary>[],
    calls: [] as string[],
  };
  const move = (ref: string, from: 'queue' | 'reviewed', to: 'queue' | 'reviewed') => {
    const position = state[from].find((entry) => entry.ref === ref);
    state[from] = state[from].filter((entry) => entry.ref !== ref);
    if (position !== undefined) state[to] = [...state[to], position];
  };
  const routes: Routes = {
    'GET /api/issues/summary': { body: { open: 0, byKind: {} } },
    'GET /api/positions': (_body, url) => {
      const positions = url.searchParams.get('review') === 'reviewed' ? state.reviewed : state.queue;
      return {
        body: { positions, total: positions.length, instruments: { [TCS]: 'TCS', [INFY]: 'Infosys' } },
      };
    },
    'GET /api/positions/review-count': () => ({ body: { count: state.queue.length } }),
    'GET /api/positions/cmVmVENT': { body: DETAIL },
    'POST /api/positions/cmVmVENT/review': () => {
      state.calls.push('review TCS');
      move('cmVmVENT', 'queue', 'reviewed');
      return { body: { ok: true } };
    },
    'POST /api/positions/cmVmSU5GWQ/review': () => {
      state.calls.push('review INFY');
      move('cmVmSU5GWQ', 'queue', 'reviewed');
      return { body: { ok: true } };
    },
    'POST /api/positions/cmVmVENT/reopen': () => {
      state.calls.push('reopen TCS');
      move('cmVmVENT', 'reviewed', 'queue');
      return { body: { ok: true } };
    },
  };
  return { state, routes };
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
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading positions', () => {
  it('checks the listing and sums charges per component, billed where a statement covers a fill', () => {
    const list = positionList({ positions: [summary('r', TCS)], total: 1, instruments: {} });
    expect(list.positions[0]?.realisedGrossMicro).toBe(200_000_000n);
    expect(() =>
      positionList({ positions: [summary('r', TCS, { state: 'GONE' })], total: 1, instruments: {} }),
    ).toThrow(ApiError);
    expect(chargeLines(positionDetail(DETAIL).charges)).toEqual([
      { component: 'brokerage', estimatedMicro: 0n, reportedMicro: null, effectiveMicro: 0n },
      // The buy's STT is billed (1.10); the sell's has no statement row, so its estimate (1.20) counts.
      { component: 'stt', estimatedMicro: 2_200_000n, reportedMicro: 1_100_000n, effectiveMicro: 2_300_000n },
    ]);
  });
});

describe('the review queue', () => {
  it('lists closed positions with their net P&L and counts them on the navigation', async () => {
    const { routes } = server();
    renderAt('/review', routes);
    const table = await screen.findByRole('table', { name: /Closed positions to review/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('TCS');
    expect(rows[0]).toHaveTextContent('15 Sep 2025');
    expect(rows[0]).toHaveTextContent('3 days');
    expect(rows[0]).toHaveTextContent('+₹197.50');
    expect(rows[1]).toHaveTextContent('−₹502.50');
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(await nav.findByRole('link', { name: 'Review, 2 to review' })).toBeInTheDocument();
  });

  it('j and k move between positions; r marks one reviewed and focus moves to the next', async () => {
    const { state, routes } = server();
    renderAt('/review', routes);
    await screen.findByRole('link', { name: 'TCS' });
    screen.getByRole('link', { name: 'TCS' }).focus();
    await userEvent.keyboard('j');
    expect(screen.getByRole('link', { name: 'Infosys' })).toHaveFocus();
    await userEvent.keyboard('k');
    expect(screen.getByRole('link', { name: 'TCS' })).toHaveFocus();
    await userEvent.keyboard('{Control>}r{/Control}');
    expect(state.calls).toEqual([]);
    await userEvent.keyboard('r');
    expect(await screen.findByText('Marked reviewed.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Infosys' })).toHaveFocus();
    });
    await userEvent.keyboard('r');
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
    expect(state.calls).toEqual(['review TCS', 'review INFY']);
  });

  it('reopens a review from the Reviewed tab', async () => {
    const { state, routes } = server();
    state.reviewed = [summary('cmVmVENT', TCS, { reviewedAt: '2026-10-20T10:00:00Z' })];
    state.queue = [];
    renderAt('/review', routes);
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    const reviewed = await screen.findByRole('table', { name: 'Reviewed positions' });
    await userEvent.click(within(reviewed).getByRole('button', { name: 'Reopen TCS' }));
    expect(await screen.findByText('Back in the review queue.')).toBeInTheDocument();
    expect(state.calls).toEqual(['reopen TCS']);
  });
});

describe('the position detail', () => {
  it('shows the flags in words, the figures, lots, fills with the broker row, and the charges', async () => {
    const { routes } = server();
    renderAt('/positions/cmVmVENT', routes);
    expect(await screen.findByRole('heading', { level: 1, name: 'TCS' })).toBeInTheDocument();
    expect(screen.getByText('Z main · delivery · 12 Sep 2025 to 15 Sep 2025')).toBeInTheDocument();
    expect(screen.getByText(/The product type was inferred/)).toBeInTheDocument();
    expect(screen.getByText(/The broker billed differently/)).toBeInTheDocument();
    expect(screen.getByText('Net P&L').nextElementSibling).toHaveTextContent('+₹197.50');
    const fills = screen.getByRole('table', { name: /Fills/ });
    expect(within(fills).getByText('delivery (inferred)')).toBeInTheDocument();
    expect(within(fills).getByText('12 Sep 2025, 10:00 IST')).toBeInTheDocument();
    expect(within(fills).getByText(/TCS,INE467B01029,2025-09-12/)).toBeInTheDocument();
    const charges = screen.getByRole('table', { name: /Charges/ });
    expect(within(charges).getByRole('row', { name: /STT/ })).toHaveTextContent(
      /STT.*₹2\.20.*₹1\.10.*₹2\.30/,
    );
    expect(within(charges).getByRole('row', { name: /Brokerage/ })).toHaveTextContent('No statement');
  });

  it('marks the position reviewed', async () => {
    const { state, routes } = server();
    renderAt('/positions/cmVmVENT', routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    expect(await screen.findByText('Marked reviewed.')).toBeInTheDocument();
    expect(state.calls).toEqual(['review TCS']);
  });

  it('says so when the position is no longer there', async () => {
    const { routes } = server();
    renderAt('/positions/bm9wZQ', routes);
    expect(await screen.findByText('This position is no longer there')).toBeInTheDocument();
  });
});
