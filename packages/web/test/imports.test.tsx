// S13b-2: the import page against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { importError, preview } from '@/lib/imports';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

/** Preview requests: POSTs to /api/imports (GETs there are the history). */
const previews = (calls: readonly FetchCall[]) =>
  calls.filter(
    ([input, init]) =>
      typeof input === 'string' && input.startsWith('/api/imports?') && init?.method === 'POST',
  );

const TOKEN = 'T'.repeat(43);
const COUNTS = (fresh: number, duplicate = 0) => ({
  rows: { new: fresh, duplicate },
  statements: { new: 0, duplicate: 0 },
  skipped: {},
  errors: 0,
});

const READY = {
  index: 0,
  label: null,
  status: 'ready',
  broker: 'dhan',
  kind: 'dhan.trade_history',
  counts: { ...COUNTS(112, 3), skipped: { fno: 2 }, errors: 1 },
  errors: [{ line: 40, code: 'bad_price' }],
  coverage: { from: '2024-04-01', to: '2024-06-30' },
  warnings: ['wrong_account'],
  issueForecast: [
    {
      kind: 'incomplete_position',
      change: 'create',
      instrumentKey: 'INE0',
      bucket: 'DELIVERY',
      orphanQty: '5',
    },
  ],
};

function server() {
  const state = {
    previews: [] as { kinds: string[] }[],
    imported: false,
    calls: [] as string[],
  };
  const routes: Routes = {
    'GET /api/profiles': {
      body: {
        profiles: [
          { id: 'p1', name: 'Swing', accounts: [{ id: 'a1', broker: 'dhan', nickname: 'D main' }] },
          { id: 'p2', name: 'Long-term', accounts: [{ id: 'a2', broker: 'zerodha', nickname: 'Kite' }] },
        ],
      },
    },
    'POST /api/imports': () => {
      state.calls.push('preview');
      return {
        body: {
          token: TOKEN,
          expiresAt: '2026-10-21T12:15:00.000Z',
          files: [
            READY,
            { index: 1, label: null, status: 'wrong_broker', broker: 'zerodha', kind: 'zerodha.tradebook' },
            {
              index: 2,
              label: null,
              status: 'ambiguous',
              candidates: [
                { broker: 'dhan', kind: 'dhan.pnl', confidence: 1 },
                { broker: 'dhan', kind: 'dhan.realised_pnl', confidence: 1 },
              ],
            },
          ],
        },
      };
    },
    'POST /api/imports/commit': (body) => {
      state.calls.push(`commit ${(body as { token: string }).token === TOKEN ? 'token' : 'other'}`);
      state.imported = true;
      return {
        body: {
          batches: [{ batchId: 'b1', kind: 'dhan.trade_history', inserted: { rows: 112, statements: 0 } }],
        },
      };
    },
    'GET /api/imports': () => ({
      body: {
        imports: state.imported
          ? [
              {
                id: 'b1',
                kind: 'dhan.trade_history',
                from: '2024-04-01',
                to: '2024-06-30',
                counts: COUNTS(112),
                createdAt: '2026-10-21T06:00:00.000Z',
              },
            ]
          : [],
      },
    }),
    'GET /api/coverage': () => ({
      body: {
        coverage: state.imported
          ? [
              {
                kind: 'dhan.trade_history',
                ranges: [
                  { from: '2024-04-01', to: '2024-04-30' },
                  { from: '2024-06-01', to: '2024-06-30' },
                ],
                gaps: [{ from: '2024-05-01', to: '2024-05-31' }],
              },
            ]
          : [],
      },
    }),
    'DELETE /api/imports/b1': () => {
      state.calls.push('undo b1');
      state.imported = false;
      return { body: { accountId: 'a1', removed: { rows: 112, statements: 0 } } };
    },
  };
  return { state, routes };
}

function renderImport(routes: Routes) {
  const fetch = stubServer(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/import'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return fetch;
}

const files = () => [
  new File(['a'], 'dhan-trades.csv'),
  new File(['b'], 'tradebook.csv'),
  new File(['c'], 'pnl.csv'),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading previews', () => {
  it('accepts every status the server sends and refuses anything else', () => {
    expect(
      preview({ token: null, expiresAt: 'x', files: [READY, { index: 1, status: 'unrecognised' }] }).files,
    ).toHaveLength(2);
    for (const body of [
      { token: 'short', expiresAt: 'x', files: [] },
      { token: null, expiresAt: 'x', files: [{ index: 0, status: 'imported' }] },
      {
        token: null,
        expiresAt: 'x',
        files: [{ ...READY, counts: { ...READY.counts, rows: { new: -1, duplicate: 0 } } }],
      },
      {
        token: null,
        expiresAt: 'x',
        files: [{ ...READY, coverage: { from: '01-04-2024', to: '2024-06-30' } }],
      },
      { token: null, expiresAt: 'x', files: [{ index: 0, status: 'unreadable', reason: 'huge' }] },
    ]) {
      expect(() => preview(body)).toThrow(ApiError);
    }
  });

  it('turns server codes into messages', () => {
    expect(importError(new ApiError(410, 'preview_expired'))).toMatch(/expired/);
    expect(importError(new ApiError(413, 'too_many_files'))).toBe('Preview at most 10 files at a time.');
    expect(importError(new Error('x'))).toBe('That did not work. Try again.');
  });
});

describe('the import page', () => {
  it('previews chosen files, explaining each one, without sending their names', async () => {
    const { routes } = server();
    const fetch = renderImport(routes);
    expect(await screen.findByLabelText('Import into')).toHaveDisplayValue('D main (Dhan, Swing)');
    await userEvent.upload(screen.getByLabelText('Broker files'), files());
    const table = await screen.findByRole('region', { name: 'Preview' });
    const ready = within(table).getByRole('row', { name: /dhan-trades\.csv/ });
    expect(ready).toHaveTextContent('Dhan trade history');
    expect(ready).toHaveTextContent('01 Apr 2024 – 30 Jun 2024');
    expect(ready).toHaveTextContent('Skipped: 2 F&O.');
    expect(ready).toHaveTextContent(
      "Few of these trades match what this account already has. Check it isn't someone else's file.",
    );
    expect(ready).toHaveTextContent('1 position would be incomplete');
    expect(ready).toHaveTextContent('1 row could not be read');
    expect(within(table).getByRole('row', { name: /tradebook\.csv/ })).toHaveTextContent(
      'A Zerodha file, but this is a Dhan account.',
    );
    expect(screen.getByRole('button', { name: 'Import 112 new trade rows' })).toHaveFocus();

    const [sent] = previews(fetch.mock.calls as FetchCall[]);
    expect(sent?.[0]).toBe('/api/imports?accountId=a1');
    const body = sent?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.getAll('file').map((part) => (part as File).name)).toEqual(['upload', 'upload', 'upload']);
    expect(form.getAll('kind')).toEqual(['', '', '']);
  });

  it('asks which report an ambiguous file is, and previews again with the pick', async () => {
    const { routes } = server();
    const fetch = renderImport(routes);
    await userEvent.upload(await screen.findByLabelText('Broker files'), files());
    await userEvent.selectOptions(
      await screen.findByLabelText('Which report is pnl.csv?'),
      'dhan.realised_pnl',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use this' }));
    await waitFor(() => {
      expect(previews(fetch.mock.calls as FetchCall[])).toHaveLength(2);
    });
    const last = previews(fetch.mock.calls as FetchCall[]).at(-1);
    expect((last?.[1]?.body as FormData).getAll('kind')).toEqual(['', '', 'dhan.realised_pnl']);
  });

  it('imports, then shows the history and coverage with its gap; undo asks first', async () => {
    const { state, routes } = server();
    renderImport(routes);
    expect(await screen.findByText('Nothing imported into this account yet.')).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Broker files'), files());
    await userEvent.click(await screen.findByRole('button', { name: 'Import 112 new trade rows' }));
    expect(
      await screen.findByText(
        'Imported 112 new trade rows and 0 statement rows into D main. Positions were recomputed.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
    expect(state.calls).toEqual(['preview', 'commit token']);

    const history = await screen.findByRole('region', { name: 'Imports' });
    expect(within(history).getByRole('row', { name: /21 Oct 2026, 11:30 IST/ })).toHaveTextContent('112');
    expect(screen.getByText(/Not covered: 01 May 2024 – 31 May 2024/)).toBeInTheDocument();
    expect(screen.getByText(/web\.dhan\.co/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Undo the Dhan trade history import/ }));
    const confirm = screen.getByRole('group', { name: /Confirm undoing the import/ });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo import' }));
    expect(
      await screen.findByText(
        'Undid the Dhan trade history import from 21 Oct 2026, 11:30 IST; 112 trade rows removed.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('Nothing imported into this account yet.')).toBeInTheDocument();
    expect(state.calls).toEqual(['preview', 'commit token', 'undo b1']);
  });

  it('switching account starts the wizard afresh', async () => {
    const { routes } = server();
    renderImport(routes);
    await userEvent.upload(await screen.findByLabelText('Broker files'), files());
    expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Import into'), 'a2');
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  });
});
