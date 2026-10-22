// S14a-3b: the journal form, screenshots and merging colliding entries, against a stubbed server through the real
// router. jsdom has no canvas encoder, so the WebP conversion is exercised with stubs here and for real in the E2E.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREENSHOT_BYTES, microToRupees, positionRefOf, toWebp } from '@/lib/journal';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const TCS = 'INE467B01029';
const REF = 'cmVmVENT';

const position = (overrides: Record<string, unknown> = {}) => ({
  ref: REF,
  accountId: 'a1',
  accountNickname: 'Z main',
  broker: 'zerodha',
  instrumentKey: TCS,
  bucket: 'DELIVERY',
  state: 'OPEN',
  incomplete: false,
  excluded: false,
  orphanQty: '0',
  openedAtUtc: '2025-09-12T04:30:00.000Z',
  closedAtUtc: null,
  openQty: '10',
  boughtQty: '10',
  boughtValueMicro: '1000000000',
  soldValueMicro: '0',
  realisedGrossMicro: '0',
  chargesMicro: '1000000',
  feeStatus: 'FEES_ESTIMATED',
  reviewedAt: null,
  journalEntries: 0,
  ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'jnl_1',
  setupTagId: null,
  mistakeTagIds: [],
  thesis: null,
  initialStopMicro: null,
  plannedStopMicro: null,
  plannedTargetMicro: null,
  plannedRiskMicro: null,
  reviewNote: null,
  reviewedAt: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  updatedAt: '2026-10-01T05:00:00.000Z',
  attachments: [],
  ...overrides,
});

function server() {
  const state = {
    position: position(),
    journal: [] as ReturnType<typeof entry>[],
    saved: [] as unknown[],
    uploads: 0,
    deleted: [] as string[],
    merged: [] as unknown[],
    issues: [] as Record<string, unknown>[],
    ensured: 0,
    /** The next save answers this error. */
    failSave: null as string | null,
  };
  const routes: Routes = {
    'GET /api/issues/summary': () => ({ body: { open: state.issues.length, byKind: {} } }),
    'GET /api/positions/review-count': { body: { count: 0 } },
    'GET /api/profiles': { body: { profiles: [] } },
    'GET /api/tags': {
      body: {
        tags: [
          { id: 'tag_bo', kind: 'setup', name: 'Breakout', uses: 0 },
          { id: 'tag_fomo', kind: 'mistake', name: 'FOMO', uses: 0 },
          { id: 'tag_late', kind: 'mistake', name: 'Late exit', uses: 0 },
        ],
      },
    },
    [`GET /api/positions/${REF}`]: () => ({
      body: {
        position: state.position,
        instruments: { [TCS]: 'TCS' },
        fills: [],
        lots: [],
        charges: [],
        feeDiscrepancies: [],
        journal: state.journal,
      },
    }),
    [`POST /api/positions/${REF}/journal/entry`]: () => {
      state.ensured += 1;
      if (state.journal.length === 0) state.journal = [entry()];
      return { body: { id: state.journal[0]?.id } };
    },
    [`PUT /api/positions/${REF}/journal`]: (body) => {
      if (state.failSave !== null) {
        const error = state.failSave;
        state.failSave = null;
        return { status: 409, body: { error } };
      }
      state.saved.push(body);
      if (state.journal.length === 0) state.journal = [entry()];
      return { body: { id: state.journal[0]?.id } };
    },
    'POST /api/journal/jnl_1/attachments': () => {
      state.uploads += 1;
      const first = state.journal[0];
      if (first !== undefined) {
        state.journal = [
          {
            ...first,
            attachments: [...first.attachments, { id: `att_${String(state.uploads)}`, bytes: 10 }],
          },
        ] as never;
      }
      return { status: 201, body: { id: `att_${String(state.uploads)}` } };
    },
    'DELETE /api/attachments/att_9': () => {
      state.deleted.push('att_9');
      state.journal = state.journal.map((value) => ({ ...value, attachments: [] }));
      return { body: { ok: true } };
    },
    'GET /api/issues': () => ({
      body: { issues: state.issues, total: state.issues.length, instruments: {} },
    }),
    'POST /api/issues/i-col/merge': (body) => {
      state.merged.push(body);
      state.issues = [];
      return { body: { ok: true } };
    },
    'POST /api/issues/i-col/dismiss': () => {
      state.merged.push('dismiss');
      state.issues = [];
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

/** A canvas whose WebP encoder returns blobs of the given sizes in turn (the browser's, in the E2E). */
function stubCanvas(sizes: readonly number[], type = 'image/webp') {
  let call = 0;
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 3000, height: 2000, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    const size = sizes[Math.min(call, sizes.length - 1)] ?? 0;
    call += 1;
    callback(new Blob([new Uint8Array(size)], { type }));
  });
  return toBlob;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('amounts, references and the WebP conversion', () => {
  it('shows stored amounts as rupees and names positions as the server does', () => {
    expect(microToRupees(95_000_000n)).toBe('95');
    expect(microToRupees(1_234_500_000n)).toBe('1234.50');
    expect(microToRupees(100_123_456n)).toBe('100.123456');
    expect(microToRupees(5_000n)).toBe('0.005');
    expect(microToRupees(0n)).toBe('0');
    expect(microToRupees(null)).toBe('');
    expect(positionRefOf('a|b#c')).toBe(Buffer.from('a|b#c').toString('base64url'));
    expect(positionRefOf('ç|é')).toBe(Buffer.from('ç|é').toString('base64url'));
  });

  it('caps the long side, then lowers quality and size until the WebP fits in 1 MB', async () => {
    const toBlob = stubCanvas([2 * MAX_SCREENSHOT_BYTES, 2 * MAX_SCREENSHOT_BYTES, 500_000]);
    const webp = await toWebp(new Blob(['x'], { type: 'image/png' }));
    expect(webp.size).toBe(500_000);
    expect(webp.type).toBe('image/webp');
    expect(toBlob).toHaveBeenCalledTimes(3);
    expect(toBlob.mock.calls.map((call) => call[2])).toEqual([0.85, 0.7, 0.55]);
  });

  it('refuses a browser without WebP', async () => {
    stubCanvas([10], 'image/png');
    await expect(toWebp(new Blob(['x']))).rejects.toMatchObject({ reason: 'no_webp' });
  });

  it('refuses an image that never fits in 1 MB', async () => {
    stubCanvas([2 * MAX_SCREENSHOT_BYTES]);
    await expect(toWebp(new Blob(['x']))).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('refuses a file that is not an image, one with too many pixels, and a failed encode', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('bad'))),
    );
    await expect(toWebp(new Blob(['x']))).rejects.toMatchObject({ reason: 'not_an_image' });
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 20_000, height: 20_000, close })),
    );
    await expect(toWebp(new Blob(['x']))).rejects.toMatchObject({ reason: 'too_many_pixels' });
    expect(close).toHaveBeenCalled();
    stubCanvas([10]);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => {
      callback(null);
    });
    await expect(toWebp(new Blob(['x']))).rejects.toMatchObject({ reason: 'encode_failed' });
  });
});

describe('the journal form', () => {
  it('saves a draft with tags and amounts in rupees', async () => {
    const { state, routes } = server();
    renderAt(`/positions/${REF}`, routes);
    expect(await screen.findByText(/The position is open: this is a draft/)).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText('Setup'), 'tag_bo');
    await userEvent.click(screen.getByRole('checkbox', { name: 'FOMO' }));
    await userEvent.type(screen.getByLabelText('Thesis'), 'Breakout above 95');
    await userEvent.type(screen.getByLabelText('Initial stop (₹)'), '95');
    await userEvent.type(screen.getByLabelText('Planned risk (₹)'), '1,000.50');
    await userEvent.click(screen.getByRole('button', { name: 'Save journal' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(state.saved).toEqual([
      {
        expectedUpdatedAt: null,
        setupTagId: 'tag_bo',
        mistakeTagIds: ['tag_fomo'],
        thesis: 'Breakout above 95',
        initialStopMicro: '95000000',
        plannedStopMicro: null,
        plannedTargetMicro: null,
        plannedRiskMicro: '1000500000',
        reviewNote: null,
      },
    ]);
  });

  it('refuses a malformed amount before sending it', async () => {
    const { state, routes } = server();
    renderAt(`/positions/${REF}`, routes);
    await userEvent.type(await screen.findByLabelText('Target (₹)'), '12.345');
    await userEvent.click(screen.getByRole('button', { name: 'Save journal' }));
    expect(
      await screen.findByText(/Target \(₹\): enter rupees with at most two decimals/),
    ).toBeInTheDocument();
    expect(state.saved).toEqual([]);
  });

  it('keeps the initial stop read-only once the position has closed, saying why', async () => {
    const { state, routes } = server();
    state.position = position({ state: 'CLOSED', closedAtUtc: '2025-09-15T05:30:00.000Z', openQty: '0' });
    state.journal = [entry({ initialStopMicro: '95000000', thesis: 'Old' })];
    renderAt(`/positions/${REF}`, routes);
    const stop = await screen.findByLabelText('Initial stop (₹)');
    expect(stop).toHaveValue('95');
    expect(stop).toHaveAttribute('readonly');
    expect(stop).toHaveAccessibleDescription('Fixed once the position closed.');
    await userEvent.type(screen.getByLabelText('Review note'), 'Sold too early');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(state.saved[0]).toMatchObject({
      initialStopMicro: '95000000',
      thesis: 'Old',
      reviewNote: 'Sold too early',
    });
  });

  it('edits the older of two colliding entries and points to Issues', async () => {
    const { state, routes } = server();
    state.journal = [entry(), entry({ id: 'jnl_2' })];
    renderAt(`/positions/${REF}`, routes);
    expect(await screen.findByText(/Two journal entries belong to this position/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(state.saved[0]).toMatchObject({ entryId: 'jnl_1' });
    });
  });
});

describe('screenshots', () => {
  it('creates the entry if needed, converts and uploads picked images', async () => {
    const { state, routes } = server();
    stubCanvas([200_000]);
    renderAt(`/positions/${REF}`, routes);
    const files = await screen.findByLabelText('Screenshot files');
    await userEvent.upload(files, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
    ]);
    expect(await screen.findByText('Added 2 screenshots.')).toBeInTheDocument();
    expect(state.ensured).toBe(1);
    expect(state.saved).toEqual([]);
    expect(state.uploads).toBe(2);
    expect(
      await screen.findByRole('img', { name: 'Screenshot 2 (opens full size in a new tab)' }),
    ).toHaveAttribute('src', '/api/attachments/att_2');
  });

  it('deletes one after confirming', async () => {
    const { state, routes } = server();
    state.journal = [entry({ attachments: [{ id: 'att_9', bytes: 10 }] })];
    renderAt(`/positions/${REF}`, routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Screenshot 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    expect(await screen.findByText('Deleted the screenshot.')).toBeInTheDocument();
    expect(state.deleted).toEqual(['att_9']);
  });

  it('says why a screenshot could not be added', async () => {
    const { routes } = server();
    stubCanvas([10], 'image/png');
    renderAt(`/positions/${REF}`, routes);
    await userEvent.upload(
      await screen.findByLabelText('Screenshot files'),
      new File(['a'], 'a.png', { type: 'image/png' }),
    );
    expect(await screen.findByText(/cannot make WebP images/)).toBeInTheDocument();
  });
});

describe('two entries on one position, in the inbox', () => {
  const COLLISION = {
    id: 'i-col',
    kind: 'journal_collision',
    status: 'open',
    accountId: 'a1',
    accountNickname: 'Z main',
    broker: 'zerodha',
    createdAt: '2026-10-21T06:00:00.000Z',
  };

  it('merges into the entry chosen', async () => {
    const { state, routes } = server();
    const positionId = Buffer.from(REF, 'base64url').toString('utf8');
    state.issues = [{ ...COLLISION, subject: { positionId, journalEntryIds: ['jnl_1', 'jnl_2'] } }];
    state.journal = [
      entry({ thesis: 'Breakout above 95', reviewedAt: '2026-10-02T05:00:00.000Z' }),
      entry({ id: 'jnl_2', thesis: null, createdAt: '2026-10-05T05:00:00.000Z' }),
    ];
    renderAt('/issues', routes);
    const card = await screen.findByRole('article', { name: /Two journal entries/ });
    expect(within(card).getByRole('link', { name: 'Open the position' })).toHaveAttribute(
      'href',
      `/positions/${REF}`,
    );
    const merge = await within(card).findByRole('button', { name: 'Merge into this one' });
    expect(merge).toBeDisabled();
    await userEvent.click(await within(card).findByRole('radio', { name: /Written 05 Oct 2026: no thesis/ }));
    expect(within(card).getByRole('radio', { name: /“Breakout above 95”, reviewed/ })).toBeInTheDocument();
    await userEvent.click(merge);
    expect(
      await screen.findByText('Merged the entries; the position has one journal entry now.'),
    ).toBeInTheDocument();
    expect(state.merged).toEqual([{ intoId: 'jnl_2' }]);
  });

  it('keeps both by dismissing the issue', async () => {
    const { state, routes } = server();
    state.issues = [{ ...COLLISION, subject: { positionId: 'p', journalEntryIds: ['jnl_1', 'jnl_2'] } }];
    renderAt('/issues', routes);
    const card = await screen.findByRole('article', { name: /Two journal entries/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Keep both' }));
    expect(await screen.findByText('Dismissed the issue.')).toBeInTheDocument();
    expect(state.merged).toEqual(['dismiss']);
  });
});

describe('journal safety (S14a-3b review)', () => {
  it('sends an untouched finer amount back exactly, even on a closed position', async () => {
    const { state, routes } = server();
    state.position = position({ state: 'CLOSED', closedAtUtc: '2025-09-15T05:30:00.000Z', openQty: '0' });
    state.journal = [entry({ initialStopMicro: '100123456', plannedRiskMicro: '5000' })];
    renderAt(`/positions/${REF}`, routes);
    expect(await screen.findByLabelText('Initial stop (₹)')).toHaveValue('100.123456');
    await userEvent.type(screen.getByLabelText('Thesis'), 'Late note');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(state.saved[0]).toMatchObject({
      expectedUpdatedAt: '2026-10-01T05:00:00.000Z',
      initialStopMicro: '100123456',
      plannedRiskMicro: '5000',
    });
  });

  it('marks the malformed amount and refuses it', async () => {
    const { routes } = server();
    renderAt(`/positions/${REF}`, routes);
    const target = await screen.findByLabelText('Target (₹)');
    await userEvent.type(target, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save journal' }));
    expect(target).toHaveAttribute('aria-invalid', 'true');
    expect(target).toHaveAccessibleDescription(/enter rupees with at most two decimals/);
  });

  it('says so when the entry changed elsewhere since the form opened', async () => {
    const { state, routes } = server();
    state.failSave = 'stale';
    renderAt(`/positions/${REF}`, routes);
    await userEvent.type(await screen.findByLabelText('Thesis'), 'Mine');
    await userEvent.click(screen.getByRole('button', { name: 'Save journal' }));
    expect(await screen.findByText(/This entry changed elsewhere/)).toBeInTheDocument();
  });

  it('keeps what is typed when a screenshot creates the entry first', async () => {
    const { state, routes } = server();
    stubCanvas([200_000]);
    renderAt(`/positions/${REF}`, routes);
    await userEvent.type(await screen.findByLabelText('Thesis'), 'Typed first');
    await userEvent.upload(
      screen.getByLabelText('Screenshot files'),
      new File(['a'], 'a.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('Added the screenshot.')).toBeInTheDocument();
    expect(screen.getByLabelText('Thesis')).toHaveValue('Typed first');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    // The entry the screenshot created is the one saved over, with its time: not stale.
    expect(state.saved[0]).toMatchObject({
      expectedUpdatedAt: '2026-10-01T05:00:00.000Z',
      thesis: 'Typed first',
    });
  });

  it('skips files that are not images, and takes a pasted picture anywhere on the page', async () => {
    const { state, routes } = server();
    stubCanvas([200_000]);
    renderAt(`/positions/${REF}`, routes);
    const files = await screen.findByLabelText('Screenshot files');
    await userEvent.upload(
      files,
      [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.txt', { type: 'text/plain' })],
      { applyAccept: false },
    );
    expect(await screen.findByText(/Skipped 1 file that is not an image/)).toBeInTheDocument();
    screen.getByLabelText('Thesis').focus();
    await userEvent.paste({
      files: [new File(['c'], 'c.png', { type: 'image/png' })],
    } as unknown as DataTransfer);
    await waitFor(() => {
      expect(state.uploads).toBe(2);
    });
  });

  it('explains when the colliding entries cannot be read', async () => {
    const { state, routes } = server();
    state.issues = [
      {
        id: 'i-col',
        kind: 'journal_collision',
        status: 'open',
        accountId: 'a1',
        accountNickname: 'Z main',
        broker: 'zerodha',
        createdAt: '2026-10-21T06:00:00.000Z',
        subject: { positionId: 'gone', journalEntryIds: ['jnl_1', 'jnl_2'] },
      },
    ];
    renderAt('/issues', routes);
    expect(await screen.findByText(/The entries could not be read/)).toBeInTheDocument();
  });
});
