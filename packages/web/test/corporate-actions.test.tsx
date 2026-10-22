// S14b-2: the corporate actions page, the inbox's link into it, and the diagnostics download, against a stubbed
// server through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_DRAFT, inputOf } from '@/components/corporate-action-form';
import { ApiError } from '@/lib/api';
import { actionList, percentToBp } from '@/lib/corporate-actions';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const TATA = 'INE155A01022';
const CHILD = 'INE1TAE01010';

const SPLIT_LOT = { accountId: 'a1', instrumentKey: TATA, bucket: 'DELIVERY', entryDateIst: '2025-09-01' };

function server() {
  const state = {
    actions: [] as Record<string, unknown>[],
    calls: [] as unknown[],
    issues: [] as Record<string, unknown>[],
  };
  const routes: Routes = {
    'GET /api/issues/summary': { body: { open: 0, byKind: {} } },
    'GET /api/positions/review-count': { body: { count: 0 } },
    'GET /api/profiles': { body: { profiles: [] } },
    'GET /api/issues': () => ({
      body: { issues: state.issues, total: state.issues.length, instruments: {} },
    }),
    'GET /api/corporate-actions': () => ({
      body: { actions: state.actions, instruments: { [TATA]: 'Tata Motors' } },
    }),
    'POST /api/corporate-actions/preview': (body) => {
      state.calls.push(['preview', body]);
      return {
        body: {
          before: [{ ...SPLIT_LOT, quantity: '10', costMicro: '7000000000' }],
          after: [{ ...SPLIT_LOT, quantity: '50', costMicro: '7000000000' }],
          fractions: [
            { accountId: 'a1', instrumentKey: TATA, numerator: '1', denominator: '3', costRemovedMicro: '0' },
          ],
          instruments: { [TATA]: 'Tata Motors' },
          accounts: { a1: { nickname: 'Z main', profileId: 'p1' } },
        },
      };
    },
    'POST /api/corporate-actions': (body) => {
      state.calls.push(['apply', body]);
      state.actions = [
        {
          id: 'ca_1',
          type: 'SPLIT',
          isin: TATA,
          newIsin: null,
          exDateIst: '2025-10-14',
          allotmentDateIst: null,
          ratioNum: '5',
          ratioDen: '1',
          costSplitBp: null,
          status: 'active',
          createdAt: '2026-10-22T06:00:00.000Z',
        },
      ];
      return { status: 201, body: { id: 'ca_1' } };
    },
    'POST /api/corporate-actions/ca_1/revert': () => {
      state.calls.push('revert');
      state.actions = state.actions.map((action) => ({ ...action, status: 'reverted' }));
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

describe('reading and building actions', () => {
  it('builds the server input per type and says what is wrong', () => {
    expect(inputOf({ ...EMPTY_DRAFT, isin: TATA, exDate: '2025-10-14', num: '5' })).toEqual({
      type: 'SPLIT',
      isin: TATA,
      exDateIst: '2025-10-14',
      ratioNum: '5',
      ratioDen: '1',
    });
    expect(
      inputOf({
        ...EMPTY_DRAFT,
        type: 'DEMERGER',
        isin: TATA,
        newIsin: CHILD.toLowerCase(),
        exDate: '2025-10-14',
        num: '1',
        childPercent: '31.15',
      }),
    ).toMatchObject({ newIsin: CHILD, costSplitBp: '3115' });
    expect(
      inputOf({
        ...EMPTY_DRAFT,
        type: 'CONVERSION',
        isin: TATA,
        newIsin: TATA,
        exDate: '2025-10-14',
        num: '1',
      }),
    ).toEqual({
      problem: expect.stringContaining('different from the first') as string,
    });
    expect(inputOf({ ...EMPTY_DRAFT, isin: 'nope' })).toHaveProperty('problem');
    expect(
      inputOf({
        ...EMPTY_DRAFT,
        type: 'DEMERGER',
        isin: TATA,
        newIsin: CHILD,
        exDate: '2025-10-14',
        num: '1',
        childPercent: '101',
      }),
    ).toHaveProperty('problem');
    expect(percentToBp('68.85')).toBe('6885');
    expect(percentToBp('100')).toBe('10000');
    expect(percentToBp('31.155')).toBeNull();
    expect(() => actionList({ actions: [{ id: 'x', type: 'MERGE' }], instruments: {} })).toThrow(ApiError);
  });
});

describe('the corporate actions page', () => {
  it('previews a split, saves exactly what was previewed, lists it and reverts it', async () => {
    const { state, routes } = server();
    renderAt('/corporate-actions', routes);
    expect(await screen.findByText('None entered')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('ISIN'), TATA);
    await userEvent.type(screen.getByLabelText('Ex-date'), '2025-10-14');
    await userEvent.type(screen.getByLabelText('Shares after'), '5');
    expect(screen.queryByRole('button', { name: 'Save this action' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const before = await screen.findByRole('table', { name: 'Open lots before the action' });
    expect(within(before).getByRole('row', { name: /Z main/ })).toHaveTextContent('10');
    expect(screen.getByRole('table', { name: 'Open lots after the action' })).toHaveTextContent('50');
    expect(screen.getByText(/a fraction of 1\/3 of a share is left over/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save this action' }));
    expect(
      await screen.findByText('Saved the corporate action; every account was rebuilt.'),
    ).toBeInTheDocument();
    const entered = await screen.findByRole('table', { name: /Corporate actions entered/ });
    expect(within(entered).getByRole('row', { name: /Split/ })).toHaveTextContent(
      'Tata Motors (INE155A01022): 5 for 1',
    );
    await userEvent.click(within(entered).getByRole('button', { name: 'Revert' }));
    expect(await screen.findByText('Reverted; every account was rebuilt without it.')).toBeInTheDocument();
    expect(state.calls).toEqual([
      ['preview', { type: 'SPLIT', isin: TATA, exDateIst: '2025-10-14', ratioNum: '5', ratioDen: '1' }],
      ['apply', { type: 'SPLIT', isin: TATA, exDateIst: '2025-10-14', ratioNum: '5', ratioDen: '1' }],
      'revert',
    ]);
  });

  it('drops a preview that answers after the fields changed', async () => {
    const { routes } = server();
    let release: () => void = () => undefined;
    // Hold the preview's answer until released: the fields change meanwhile.
    const fetch = stubServer(routes);
    const real = fetch.getMockImplementation();
    if (real === undefined) throw new Error('no stub');
    fetch.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/preview')) return real(input, init);
      return new Promise<Response>((resolve) => {
        release = () => {
          void real(input, init).then(resolve);
        };
      });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      routeTree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ['/corporate-actions'] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText('ISIN'), TATA);
    await userEvent.type(screen.getByLabelText('Ex-date'), '2025-10-14');
    await userEvent.type(screen.getByLabelText('Shares after'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    // Changed while the preview is on its way: its answer belongs to other fields.
    await userEvent.type(screen.getByLabelText('Shares after'), '0');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Save this action' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Open lots before the action' })).toBeNull();
  });

  it('says why a save failed', async () => {
    const { routes } = server();
    renderAt('/corporate-actions', {
      ...routes,
      'POST /api/corporate-actions': { status: 409, body: { error: 'conflict' } },
    });
    await userEvent.type(await screen.findByLabelText('ISIN'), TATA);
    await userEvent.type(screen.getByLabelText('Ex-date'), '2025-10-14');
    await userEvent.type(screen.getByLabelText('Shares after'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save this action' }));
    expect(await screen.findByText(/This conflicts with what is stored/)).toBeInTheDocument();
  });

  it('clears the preview when a field changes, so nothing unpreviewed is saved', async () => {
    const { routes } = server();
    renderAt('/corporate-actions', routes);
    await userEvent.type(await screen.findByLabelText('ISIN'), TATA);
    await userEvent.type(screen.getByLabelText('Ex-date'), '2025-10-14');
    await userEvent.type(screen.getByLabelText('Shares after'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('button', { name: 'Save this action' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Shares after'), '0');
    expect(screen.queryByRole('button', { name: 'Save this action' })).toBeNull();
  });

  it('shows an unreadable stored action so it can be reverted', async () => {
    const { state, routes } = server();
    state.actions = [
      { id: 'ca_bad', unreadable: true, status: 'active', createdAt: '2026-10-22T06:00:00.000Z' },
    ];
    renderAt('/corporate-actions', routes);
    const entered = await screen.findByRole('table', { name: /Corporate actions entered/ });
    expect(within(entered).getByRole('row', { name: /Unreadable/ })).toHaveTextContent(
      /revert it, then enter it again/,
    );
  });

  it('starts from what an issue noticed', async () => {
    const { routes } = server();
    renderAt(
      `/corporate-actions?type=DEMERGER&isin=${TATA}&newIsin=${CHILD}&exDate=2025-10-14&num=1`,
      routes,
    );
    expect(await screen.findByText(/Filled in from what BhavBook noticed/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Demerger' })).toBeChecked();
    expect(screen.getByLabelText('Parent ISIN')).toHaveValue(TATA);
    expect(screen.getByLabelText('Child ISIN')).toHaveValue(CHILD);
    expect(screen.getByLabelText('Ex-date')).toHaveValue('2025-10-14');
    expect(screen.getByLabelText('Child shares')).toHaveValue('1');
  });

  it('forgets the suggestion once it is saved', async () => {
    const { routes } = server();
    renderAt(`/corporate-actions?type=SPLIT&isin=${TATA}&exDate=2025-10-14&num=5`, routes);
    expect(await screen.findByText(/Filled in from what BhavBook noticed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Preview ready: 1 open lot before, 1 after.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Save this action' }));
    expect(
      await screen.findByText('Saved the corporate action; every account was rebuilt.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Filled in from what BhavBook noticed/)).toBeNull();
    expect(screen.getByLabelText('ISIN')).toHaveValue('');
  });
});

describe('the inbox link and the diagnostics download', () => {
  const SUSPECTED = {
    id: 'i-ca',
    kind: 'corporate_action_suspected',
    status: 'open',
    accountId: 'a1',
    accountNickname: 'Z main',
    broker: 'zerodha',
    createdAt: '2026-10-21T06:00:00.000Z',
  };

  it('links a suspected split or bonus to the form, filled in either way', async () => {
    const { state, routes } = server();
    state.issues = [
      {
        ...SUSPECTED,
        subject: { kind: 'split_or_bonus', instrumentKey: TATA, dateIst: '2025-10-14', multiple: '5' },
      },
    ];
    renderAt('/issues', routes);
    const card = await screen.findByRole('article', { name: /Possible corporate action/ });
    expect(card).toHaveTextContent('sales on 14 Oct 2025 ran to 5 times the shares held');
    expect(card).toHaveTextContent('ex-date on or before then');
    expect(within(card).getByRole('link', { name: 'Enter as a split (5 for 1)…' })).toBeInTheDocument();
    // Followed through the router: its search encoding is its own, so the href is not pinned.
    await userEvent.click(within(card).getByRole('link', { name: 'Enter as a bonus (4 for 1)…' }));
    expect(await screen.findByRole('radio', { name: 'Bonus' })).toBeChecked();
    expect(screen.getByLabelText('ISIN')).toHaveValue(TATA);
    expect(screen.getByLabelText('Ex-date')).toHaveValue('2025-10-14');
    expect(screen.getByLabelText('Bonus shares')).toHaveValue('4');
    expect(screen.getByLabelText('Shares held')).toHaveValue('1');
  });

  it('links an ISIN change 1 for 1, and asks for a mapping when a scrip has no ISIN', async () => {
    const { state, routes } = server();
    state.issues = [
      {
        ...SUSPECTED,
        subject: {
          kind: 'conversion_or_demerger',
          fromInstrument: TATA,
          toInstrument: CHILD,
          dateIst: '2025-10-14',
        },
      },
      {
        ...SUSPECTED,
        id: 'i-local',
        subject: {
          kind: 'split_or_bonus',
          instrumentKey: 'local:dhan:Some Scrip',
          dateIst: '2025-10-14',
          multiple: '2',
        },
      },
    ];
    renderAt('/issues', routes);
    const cards = await screen.findAllByRole('article', { name: /Possible corporate action/ });
    const local = cards.find((card) => card.textContent.includes('without an ISIN'));
    expect(local).toBeDefined();
    if (local !== undefined) expect(within(local).queryByRole('link', { name: /Enter/ })).toBeNull();
    const conversion = cards.find((card) => card.textContent.includes('stopped trading'));
    if (conversion === undefined) throw new Error('no conversion card');
    await userEvent.click(within(conversion).getByRole('link', { name: 'Enter it…' }));
    expect(await screen.findByRole('radio', { name: 'ISIN change' })).toBeChecked();
    expect(screen.getByLabelText('New ISIN')).toHaveValue(CHILD);
    expect(screen.getByLabelText('New shares')).toHaveValue('1');
  });

  it('offers the diagnostics download in Settings', async () => {
    const { routes } = server();
    renderAt('/settings', routes);
    const link = await screen.findByRole('link', { name: 'Download diagnostics' });
    expect(link).toHaveAttribute('href', '/api/diagnostics');
  });
});
