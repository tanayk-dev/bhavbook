// S13c-2: the issues inbox against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rupeesToMicro } from '@/components/issue-fixes';
import { ApiError } from '@/lib/api';
import { feeDiscrepancy, issueList, lotSuggestion } from '@/lib/issues';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const BAJAJ = 'INE377Y01014';
const base = {
  accountId: 'a1',
  accountNickname: 'D main',
  broker: 'dhan',
  createdAt: '2026-10-21T06:00:00.000Z',
};

const FILL = {
  ...base,
  id: 'i-fill',
  kind: 'fill_from_statement',
  status: 'open',
  subject: {
    instrumentKey: BAJAJ,
    bucket: 'DELIVERY',
    quantity: '200',
    totalCostMicro: '35200000000',
    entryDateIst: '2024-09-17',
    statementKey: 'k',
  },
};
const INCOMPLETE = {
  ...base,
  id: 'i-inc',
  kind: 'incomplete_position',
  status: 'open',
  subject: {
    instrumentKey: BAJAJ,
    bucket: 'DELIVERY',
    orphanQty: '200',
    // 00:30 IST on 18 Sep: the UTC date is the 17th.
    openedAtUtc: '2024-09-17T19:00:00Z',
    anchorKey: 'anchor#DELIVERY',
  },
};
const UNKNOWN = {
  ...base,
  id: 'i-unk',
  kind: 'unresolved_instrument',
  status: 'open',
  subject: { broker: 'dhan', alias: 'Bajaj Hsg', reason: 'no_match', candidates: [] },
};
const FEES = {
  ...base,
  id: 'i-fee',
  kind: 'fee_discrepancy',
  status: 'open',
  subject: {
    instrumentKey: BAJAJ,
    bucket: 'DELIVERY',
    discrepancies: [
      {
        scope: 'note',
        dateIst: '2024-09-18',
        exchange: 'NSE',
        instrumentKey: null,
        component: 'stt',
        estimatedMicro: '39000000',
        reportedMicro: '40000000',
      },
    ],
  },
};
const SUSPECT = {
  ...base,
  id: 'i-ca',
  kind: 'corporate_action_suspected',
  status: 'open',
  subject: { instrumentKey: BAJAJ },
};

function server() {
  const state = {
    open: [FILL, INCOMPLETE, UNKNOWN, FEES, SUSPECT] as Record<string, unknown>[],
    dismissed: [] as Record<string, unknown>[],
    calls: [] as string[],
  };
  const take = (id: string) => {
    const issue = state.open.find((entry) => entry.id === id);
    state.open = state.open.filter((entry) => entry.id !== id);
    return issue;
  };
  const routes: Routes = {
    'GET /api/profiles': {
      body: {
        profiles: [{ id: 'p1', name: 'Swing', accounts: [{ id: 'a1', broker: 'dhan', nickname: 'D main' }] }],
      },
    },
    'GET /api/issues': () => ({
      body: {
        issues: state.open,
        total: state.open.length,
        instruments: { [BAJAJ]: 'Bajaj Housing Finance' },
      },
    }),
    'GET /api/issues/summary': () => ({
      body: {
        open: state.open.length,
        byKind: Object.fromEntries(state.open.map((issue) => [String(issue.kind), 1])),
      },
    }),
    'POST /api/issues/i-fill/accept': () => {
      state.calls.push('accept');
      take('i-fill');
      take('i-inc');
      return { body: { adjustmentId: 'adj1' } };
    },
    'POST /api/issues/i-ca/dismiss': () => {
      state.calls.push('dismiss');
      const issue = take('i-ca');
      if (issue !== undefined) state.dismissed.push({ ...issue, status: 'dismissed' });
      return { body: { ok: true } };
    },
    'POST /api/accounts/a1/adjustments': (body) => {
      state.calls.push(`adjust ${JSON.stringify(body)}`);
      take('i-inc');
      return { status: 201, body: { id: 'adj2' } };
    },
    'GET /api/issues/i-unk/suggestions': {
      body: {
        suggestions: [{ instrumentId: 'ins1', isin: BAJAJ, name: 'Bajaj Housing Finance', score: 0.9 }],
      },
    },
    'POST /api/issues/i-unk/map': (body) => {
      state.calls.push(`map ${JSON.stringify(body)}`);
      take('i-unk');
      return { body: { ok: true } };
    },
  };
  return { state, routes };
}

function renderInbox(routes: Routes) {
  stubServer(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/issues'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const card = (name: RegExp) => screen.findByRole('article', { name });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading issues', () => {
  it("accepts the listing and reads each kind's subject, refusing what does not fit", () => {
    expect(issueList({ issues: [FILL], total: 1, instruments: {} }).issues).toHaveLength(1);
    expect(() => issueList({ issues: [{ ...FILL, status: 'gone' }], total: 1, instruments: {} })).toThrow(
      ApiError,
    );
    expect(lotSuggestion(FILL.subject)).toMatchObject({ quantity: 200n, totalCostMicro: 35_200_000_000n });
    expect(lotSuggestion({ ...FILL.subject, quantity: 2 })).toBeNull();
    expect(feeDiscrepancy(FEES.subject)?.differences[0]).toMatchObject({
      estimatedMicro: 39_000_000n,
      reportedMicro: 40_000_000n,
    });
    expect(
      feeDiscrepancy({ unmatchedStatementRow: true, dateIst: '2024-05-02', instrumentKey: null })
        ?.unmatchedRow,
    ).toEqual({
      dateIst: '2024-05-02',
      instrumentKey: null,
    });
    expect(rupeesToMicro('35200')).toBe('35200000000');
    expect(rupeesToMicro('0.5')).toBe('500000');
    expect(rupeesToMicro('20,00,000')).toBe('2000000000000');
    expect(rupeesToMicro('0')).toBeNull();
    expect(rupeesToMicro('1.234')).toBeNull();
  });
});

describe('the inbox', () => {
  it('shows each issue in plain words, with the open count on the navigation', async () => {
    const { routes } = server();
    renderInbox(routes);
    const fill = await card(/Fill from broker statement: Bajaj Housing Finance/);
    expect(fill).toHaveTextContent(
      "The broker's tax report has a lot that would complete this position: 200 shares",
    );
    expect(fill).toHaveTextContent('17 Sep 2024');
    expect(fill).toHaveTextContent('35,200.00');
    expect(await card(/Charges differ from the statement/)).toHaveTextContent('STT (whole contract note)');
    expect(await card(/Possible corporate action/)).toHaveTextContent('split, bonus');
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: /Issues/ }),
    ).toHaveTextContent('5 open');
  });

  it('uses the statement lot, which resolves the position too', async () => {
    const { state, routes } = server();
    renderInbox(routes);
    const fill = await card(/Fill from broker statement/);
    await userEvent.click(within(fill).getByRole('button', { name: 'Use this lot' }));
    expect(
      await screen.findByText('Used the statement lot; the position was recomputed.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: /Incomplete position/ })).toBeNull();
    });
    expect(state.calls).toEqual(['accept']);
  });

  it('adds an opening lot, checking what was typed first', async () => {
    const { state, routes } = server();
    renderInbox(routes);
    const incomplete = await card(/Incomplete position/);
    await userEvent.click(within(incomplete).getByRole('button', { name: 'Add opening lot…' }));
    expect(incomplete).toHaveTextContent('in a position from 18 Sep 2024');
    await userEvent.type(within(incomplete).getByLabelText('Total cost (₹)'), '20,00,000');
    await userEvent.click(within(incomplete).getByRole('button', { name: 'Add opening lot' }));
    expect(within(incomplete).getByRole('alert')).toHaveTextContent('Enter when they were bought');
    await userEvent.type(within(incomplete).getByLabelText('Bought on'), '2024-09-19');
    await userEvent.click(within(incomplete).getByRole('button', { name: 'Add opening lot' }));
    expect(within(incomplete).getByRole('alert')).toHaveTextContent(
      "on or before the position's first trade",
    );
    await userEvent.clear(within(incomplete).getByLabelText('Bought on'));
    await userEvent.type(within(incomplete).getByLabelText('Bought on'), '2024-09-18');
    await userEvent.click(within(incomplete).getByRole('button', { name: 'Add opening lot' }));
    expect(
      await screen.findByText('Added the opening lot; the position was recomputed.'),
    ).toBeInTheDocument();
    expect(state.calls).toEqual([
      `adjust ${JSON.stringify({ kind: 'opening_lot', instrumentKey: BAJAJ, bucket: 'DELIVERY', quantity: '200', totalCostMicro: '2000000000000', entryDateIst: '2024-09-18' })}`,
    ]);
  });

  it('excludes a position after confirming', async () => {
    const { state, routes } = server();
    renderInbox(routes);
    const incomplete = await card(/Incomplete position/);
    await userEvent.click(within(incomplete).getByRole('button', { name: 'Exclude…' }));
    await userEvent.click(within(incomplete).getByRole('button', { name: 'Exclude position' }));
    expect(await screen.findByText(/Excluded the position from every metric/)).toBeInTheDocument();
    expect(state.calls).toEqual([
      `adjust ${JSON.stringify({ kind: 'exclude', anchorKey: 'anchor#DELIVERY' })}`,
    ]);
  });

  it('maps an unknown scrip to a suggested instrument', async () => {
    const { state, routes } = server();
    renderInbox(routes);
    const unknown = await card(/Unknown instrument/);
    await userEvent.click(await within(unknown).findByRole('radio', { name: /Bajaj Housing Finance/ }));
    await userEvent.click(within(unknown).getByRole('button', { name: 'Use this instrument' }));
    expect(await screen.findByText('Mapped “Bajaj Hsg”; positions were recomputed.')).toBeInTheDocument();
    expect(state.calls).toEqual([
      `map ${JSON.stringify({ isin: BAJAJ, displayName: 'Bajaj Housing Finance' })}`,
    ]);
  });

  it('refuses a malformed ISIN before sending it', async () => {
    const { state, routes } = server();
    renderInbox(routes);
    const unknown = await card(/Unknown instrument/);
    await userEvent.type(within(unknown).getByLabelText('ISIN for Bajaj Hsg'), 'nope');
    await userEvent.click(within(unknown).getByRole('button', { name: 'Use this instrument' }));
    expect(within(unknown).getByRole('alert')).toHaveTextContent('Enter a 12-character ISIN');
    expect(state.calls).toEqual([]);
  });

  it('dismisses an issue, which leaves the open list', async () => {
    const { state, routes } = server();
    renderInbox(routes);
    const suspect = await card(/Possible corporate action/);
    await userEvent.click(within(suspect).getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Dismissed the issue.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: /Possible corporate action/ })).toBeNull();
    });
    expect(state.calls).toEqual(['dismiss']);
    // The focused card left: the keyboard user lands on the issue now in its place.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Charges differ/ })).toHaveFocus();
    });
  });

  it('shows resolved issues read-only', async () => {
    const { state, routes } = server();
    state.open = [
      { ...INCOMPLETE, status: 'resolved' },
      { ...UNKNOWN, status: 'resolved' },
    ];
    renderInbox(routes);
    const incomplete = await card(/Incomplete position/);
    expect(within(incomplete).queryByRole('button')).toBeNull();
    expect(incomplete).toHaveTextContent('Resolved: nothing to do.');
    expect(within(await card(/Unknown instrument/)).queryByRole('radio')).toBeNull();
  });

  it('offers no opening lot for an intraday position, nor an exclusion without its anchor', async () => {
    const { state, routes } = server();
    state.open = [
      { ...INCOMPLETE, subject: { ...INCOMPLETE.subject, bucket: 'INTRADAY', anchorKey: undefined } },
    ];
    renderInbox(routes);
    const incomplete = await card(/Incomplete position/);
    expect(within(incomplete).queryByRole('button', { name: 'Add opening lot…' })).toBeNull();
    expect(within(incomplete).queryByRole('button', { name: 'Exclude…' })).toBeNull();
    expect(within(incomplete).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('says when the statement has no row instead of showing a zero bill', async () => {
    const { state, routes } = server();
    const missing = { ...FEES.subject.discrepancies[0], scope: 'missing', reportedMicro: '0' };
    state.open = [{ ...FEES, subject: { ...FEES.subject, discrepancies: [missing] } }];
    renderInbox(routes);
    const fees = await card(/Charges differ/);
    expect(fees).toHaveTextContent('Not on the statement');
    expect(fees).toHaveTextContent("BhavBook's estimate is kept");
  });

  it('j and k move between issues', async () => {
    const { routes } = server();
    renderInbox(routes);
    const first = await card(/Fill from broker statement/);
    within(first).getByRole('button', { name: 'Use this lot' }).focus();
    await userEvent.keyboard('j');
    expect(screen.getByRole('heading', { name: /Incomplete position/ })).toHaveFocus();
    await userEvent.keyboard('k');
    expect(screen.getByRole('heading', { name: /Fill from broker statement/ })).toHaveFocus();
    await userEvent.keyboard('{Control>}j{/Control}');
    expect(screen.getByRole('heading', { name: /Fill from broker statement/ })).toHaveFocus();
  });

  it('says so when nothing needs attention', async () => {
    const { state, routes } = server();
    state.open = [];
    renderInbox(routes);
    expect(await screen.findByText('Nothing needs your attention')).toBeInTheDocument();
  });
});
