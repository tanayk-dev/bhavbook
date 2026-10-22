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
  counts: { ...COUNTS(112, 3), skipped: { fno: 2 }, errors: 51 },
  errors: Array.from({ length: 50 }, (_, at) => ({ line: at + 2, code: 'bad_price' })),
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
    {
      kind: 'incomplete_position',
      change: 'resolve',
      instrumentKey: 'INE1',
      bucket: 'DELIVERY',
      orphanQty: '2',
    },
  ],
};
const WRONG_BROKER = {
  index: 1,
  label: null,
  status: 'wrong_broker',
  broker: 'zerodha',
  kind: 'zerodha.tradebook',
};
const AMBIGUOUS = {
  index: 2,
  label: null,
  status: 'ambiguous',
  candidates: [
    { broker: 'dhan', kind: 'dhan.pnl', confidence: 1 },
    { broker: 'dhan', kind: 'dhan.realised_pnl', confidence: 1 },
  ],
};
const HISTORY = {
  id: 'b1',
  kind: 'dhan.trade_history',
  from: '2024-04-01',
  to: '2024-06-30',
  counts: COUNTS(112),
  createdAt: '2026-10-21T06:00:00.000Z',
};
const COVERAGE = {
  kind: 'dhan.trade_history',
  ranges: [
    { from: '2024-04-01', to: '2024-04-30' },
    { from: '2024-06-01', to: '2024-06-30' },
  ],
  gaps: [{ from: '2024-05-01', to: '2024-05-31' }],
};

function server() {
  const state = {
    files: [READY, WRONG_BROKER, AMBIGUOUS] as unknown[],
    token: TOKEN as string | null,
    imported: false,
    expireCommit: false,
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
      return { body: { token: state.token, expiresAt: '2026-10-21T12:15:00.000Z', files: state.files } };
    },
    'POST /api/imports/commit': (body) => {
      state.calls.push(`commit ${(body as { token: string }).token === TOKEN ? 'token' : 'other'}`);
      if (state.expireCommit) return { status: 410, body: { error: 'preview_expired' } };
      state.imported = true;
      return {
        body: {
          batches: [{ batchId: 'b1', kind: 'dhan.trade_history', inserted: { rows: 112, statements: 0 } }],
        },
      };
    },
    'GET /api/imports': () => ({ body: { imports: state.imported ? [HISTORY] : [] } }),
    'GET /api/coverage': () => ({ body: { coverage: state.imported ? [COVERAGE] : [] } }),
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
    const statuses = [
      READY,
      WRONG_BROKER,
      AMBIGUOUS,
      { index: 3, status: 'unrecognised' },
      { index: 4, status: 'unreadable', reason: 'too_large' },
      { index: 5, status: 'rejected', broker: 'dhan', kind: 'dhan.ledger', message: 'Not imported in v1.' },
    ];
    expect(preview({ token: null, expiresAt: 'x', files: statuses }).files).toHaveLength(6);
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
  it('keeps a preview made while the import history is still loading', async () => {
    // Seen on a slow CI runner: the history's first answer arrived after the preview and dropped it.
    const { routes } = server();
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const history = routes['GET /api/imports'];
    renderImport({
      ...routes,
      'GET /api/imports': async (body, url) => {
        await answered;
        return typeof history === 'function' ? history(body, url) : { body: { imports: [] } };
      },
    });
    await userEvent.upload(await screen.findByLabelText('Broker files'), files());
    expect(
      await screen.findByText('3 files read, 1 ready, 1 to identify, 1 not importable.'),
    ).toBeInTheDocument();
    answer();
    expect(await screen.findByText('Nothing imported into this account yet.')).toBeInTheDocument();
    // The preview is still there (the ambiguous file must be identified before the import is enabled).
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import 112 new trade rows/ })).toBeInTheDocument();
  });

  it('previews chosen files, explaining each one, without sending their names', async () => {
    const { routes } = server();
    const fetch = renderImport(routes);
    expect(await screen.findByLabelText('Import into')).toHaveDisplayValue('D main (Dhan, Swing)');
    await userEvent.upload(screen.getByLabelText('Broker files'), files());
    const summary = await screen.findByText('3 files read, 1 ready, 1 to identify, 1 not importable.');
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });
    const table = screen.getByRole('region', { name: 'Preview' });
    const ready = within(table).getByRole('row', { name: /dhan-trades\.csv/ });
    expect(ready).toHaveTextContent('Dhan trade history');
    expect(ready).toHaveTextContent('01 Apr 2024 – 30 Jun 2024');
    expect(ready).toHaveTextContent('Skipped: 2 F&O.');
    expect(ready).toHaveTextContent(
      "Few of these trades match what this account already has. Check it isn't someone else's file.",
    );
    expect(ready).toHaveTextContent('1 position would be incomplete');
    expect(ready).toHaveTextContent('1 incomplete position would be completed.');
    expect(ready).toHaveTextContent('51 rows could not be read (the first 50 are listed)');
    expect(within(table).getByRole('row', { name: /tradebook\.csv/ })).toHaveTextContent(
      'A Zerodha file, but this is a Dhan account.',
    );
    // Not until the ambiguous file is identified.
    expect(screen.getByRole('button', { name: 'Import 112 new trade rows' })).toBeDisabled();
    expect(screen.getByText('Choose which report the highlighted file is first.')).toBeInTheDocument();

    const [sent] = previews(fetch.mock.calls as FetchCall[]);
    expect(sent?.[0]).toBe('/api/imports?accountId=a1');
    const form = sent?.[1]?.body as FormData;
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

  it('says why nothing can be imported', async () => {
    const { state, routes } = server();
    state.files = [WRONG_BROKER];
    state.token = null;
    renderImport(routes);
    await userEvent.upload(await screen.findByLabelText('Broker files'), files().slice(1, 2));
    expect(
      await screen.findByText('None of these files can be imported into this account.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 0 new trade rows' })).toBeDisabled();
  });

  it('imports, then shows the history and coverage with its gap; undo asks first and keeps focus', async () => {
    const { state, routes } = server();
    state.files = [READY];
    renderImport(routes);
    expect(await screen.findByText('Nothing imported into this account yet.')).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Broker files'), files().slice(0, 1));
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
    expect(screen.getByRole('link', { name: /web\.dhan\.co/ })).toHaveAttribute(
      'href',
      'https://web.dhan.co/index/profile',
    );
    expect(screen.getByRole('link', { name: /web\.dhan\.co/ })).toHaveAttribute('rel', 'noopener noreferrer');

    await userEvent.click(screen.getByRole('button', { name: /^Undo the Dhan trade history import/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /Confirm undoing the import/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Undo the Dhan trade history import/ }));
    const confirm = screen.getByRole('group', { name: /Confirm undoing the import/ });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo import' }));
    expect(
      await screen.findByText(
        'Undid the Dhan trade history import from 21 Oct 2026, 11:30 IST; 112 trade rows removed.',
      ),
    ).toBeInTheDocument();
    const empty = await screen.findByText('Nothing imported into this account yet.');
    await waitFor(() => {
      expect(empty.parentElement).toHaveFocus();
    });
    expect(state.calls).toEqual(['preview', 'commit token', 'undo b1']);
  });

  it('offers to preview again when the preview has expired', async () => {
    const { state, routes } = server();
    state.files = [READY];
    state.expireCommit = true;
    renderImport(routes);
    await userEvent.upload(await screen.findByLabelText('Broker files'), files().slice(0, 1));
    await userEvent.click(await screen.findByRole('button', { name: 'Import 112 new trade rows' }));
    expect(await screen.findByText(/This preview has expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 112 new trade rows' })).toBeDisabled();
    state.expireCommit = false;
    await userEvent.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Import 112 new trade rows' })).toBeEnabled();
    });
    expect(state.calls).toEqual(['preview', 'commit token', 'preview']);
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
