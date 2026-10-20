// S13a-3b-2: backups on the settings page against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { backups, formatBytes, restoreError } from '@/lib/backups';
import { formatIstDateTime } from '@/lib/format';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const AUTO = {
  name: 'auto-20261020T060000000Z-pre-import.bhav',
  kind: 'auto',
  reason: 'pre-import',
  createdAt: '2026-10-20T06:00:00.000Z',
  bytes: 2_516_582,
};

function server() {
  const state = {
    backups: [AUTO] as (typeof AUTO)[],
    profiles: [{ id: 'p1', name: 'Swing', accounts: [] }],
    calls: [] as string[],
    restoreReply: { body: { schemaVersion: 4 } } as { status?: number; body: unknown },
  };
  const routes: Routes = {
    'GET /api/profiles': () => ({ body: { profiles: state.profiles } }),
    'GET /api/settings': { body: { breakevenThresholdMicro: '0', feeRules: [] } },
    'GET /api/tags': { body: { tags: [] } },
    'GET /api/vault/backups': () => ({ body: { backups: state.backups } }),
    'POST /api/vault/backup': () => {
      state.calls.push('backup');
      const made = {
        name: 'backup-20261020T120000000Z-manual.bhav',
        kind: 'manual',
        reason: 'manual',
        createdAt: '2026-10-20T12:00:00.000Z',
        bytes: 49_152,
      };
      state.backups = [made, ...state.backups];
      return { status: 201, body: made };
    },
    'POST /api/vault/restore': (body) => {
      state.calls.push(`restore ${(body as { name: string }).name}`);
      if (state.restoreReply.status === undefined)
        state.profiles = [{ id: 'p9', name: 'Restored', accounts: [] }];
      return state.restoreReply;
    },
    'POST /api/vault/restore/upload': () => {
      state.calls.push('upload');
      return { status: 422, body: { error: 'not_a_backup' } };
    },
  };
  return { state, routes };
}

function renderSettings(routes: Routes) {
  const fetch = stubServer(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatting and reading', () => {
  it('shows instants in IST and sizes in KB or MB', () => {
    expect(formatIstDateTime('2026-10-20T06:00:00.000Z')).toBe('20 Oct 2026, 11:30 IST');
    expect(formatIstDateTime('2026-10-20T20:00:00Z')).toBe('21 Oct 2026, 01:30 IST');
    expect(formatIstDateTime('soon')).toBe('soon');
    expect(formatBytes(100)).toBe('1 KB');
    expect(formatBytes(49_152)).toBe('48 KB');
    expect(formatBytes(2_516_582)).toBe('2.4 MB');
    expect(formatBytes(1_048_575)).toBe('1.0 MB');
    expect(formatBytes(1_047_552)).toBe('1,023 KB');
  });

  it('refuses a listing it does not recognise, including names that are not backups', () => {
    expect(backups({ backups: [AUTO] })).toHaveLength(1);
    for (const body of [
      null,
      { backups: [{ ...AUTO, name: '../vault.db' }] },
      { backups: [{ ...AUTO, kind: 'raw' }] },
      { backups: [{ ...AUTO, createdAt: 'never' }] },
      { backups: [{ ...AUTO, createdAt: '2026-10-20T06:00:00' }] },
      { backups: [{ ...AUTO, bytes: -1 }] },
    ]) {
      expect(() => backups(body)).toThrow(ApiError);
    }
  });

  it('says the current data is unchanged whatever went wrong', () => {
    expect(restoreError(new ApiError(422, 'corrupt'))).toBe(
      'That backup is damaged, so it was not restored. Your current data is unchanged.',
    );
    expect(restoreError(new ApiError(409, 'busy'))).toBe(
      'Another restore is running. Wait for it to finish. Your current data is unchanged.',
    );
    expect(restoreError(new ApiError(503, 'reopen_failed'))).toMatch(/restart BhavBook\.$/);
    for (const error of [
      new Error('x'),
      new ApiError(0, 'unreachable'),
      new ApiError(500, 'internal_error'),
    ]) {
      expect(restoreError(error)).toBe(
        'The restore did not report back, so it may or may not have happened. Reload the page to see your data.',
      );
    }
  });
});

describe('backups in settings', () => {
  it('lists backups with a download link, and backs up on request', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    const table = await screen.findByRole('region', { name: 'Backup list' });
    const row = within(table).getByRole('row', { name: /20 Oct 2026, 11:30 IST/ });
    expect(row).toHaveTextContent('Before an import');
    expect(row).toHaveTextContent('2.4 MB');
    expect(
      within(row).getByRole('link', { name: 'Download the backup from 20 Oct 2026, 11:30 IST' }),
    ).toHaveAttribute('href', `/api/vault/backups/${AUTO.name}`);

    await userEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(await screen.findByText('Backed up BhavBook (48 KB).')).toBeInTheDocument();
    expect(await within(table).findByRole('row', { name: /20 Oct 2026, 17:30 IST/ })).toHaveTextContent(
      'Made by you',
    );
    expect(state.calls).toEqual(['backup']);
  });

  it('restores a listed backup after confirming, then shows the restored data', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restore the backup from 20 Oct 2026, 11:30 IST…' }),
    );
    const confirm = screen.getByRole('group', { name: 'Confirm restore' });
    const restore = within(confirm).getByRole('button', { name: 'Restore' });
    expect(restore).toHaveFocus();
    expect(restore).toHaveAccessibleDescription(
      'Replace everything in BhavBook with the backup from 20 Oct 2026, 11:30 IST? Your current data is backed up first, so you can restore it again from this list.',
    );
    await userEvent.click(restore);
    expect(await screen.findByText('Restored the backup from 20 Oct 2026, 11:30 IST.')).toBeInTheDocument();
    expect(state.calls).toEqual([`restore ${AUTO.name}`]);
    // Every query was refetched: the profiles now come from the restored vault.
    expect(await screen.findByRole('button', { name: 'Rename Restored' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Back up now' })).toHaveFocus();
    });
  });

  it('explains a failed restore and keeps the confirm open; Escape closes it', async () => {
    const { state, routes } = server();
    state.restoreReply = { status: 409, body: { error: 'in_use' } };
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: /^Restore the backup from/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(
      await screen.findByText(
        'Another program has the vault open. Close it and try again. Your current data is unchanged.',
      ),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Confirm restore' })).toBeNull();
  });

  it('picking a file again starts afresh, and cancel returns focus to the file picker', async () => {
    const { routes } = server();
    renderSettings(routes);
    const input = await screen.findByLabelText('Restore from a file');
    const file = new File([new Uint8Array([1])], 'same.bhav');
    await userEvent.upload(input, file);
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText(/not a BhavBook backup/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Restore' })).toHaveFocus();
    });
    await userEvent.upload(input, new File([new Uint8Array([2])], 'same.bhav'));
    expect(screen.queryByText(/not a BhavBook backup/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  it('restores from a chosen file after confirming, naming the file only on screen', async () => {
    const { state, routes } = server();
    const fetch = renderSettings(routes);
    const file = new File([new Uint8Array([1, 2, 3])], 'my-backup.bhav');
    await userEvent.upload(await screen.findByLabelText('Restore from a file'), file);
    const confirm = screen.getByRole('group', { name: 'Confirm restore' });
    expect(confirm).toHaveTextContent('Replace everything in BhavBook with the file my-backup.bhav?');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Restore' }));
    expect(
      await screen.findByText('That file is not a BhavBook backup. Your current data is unchanged.'),
    ).toBeInTheDocument();
    expect(state.calls).toEqual(['upload']);
    // The file's bytes go up; its name does not (ADR-0019).
    const upload = fetch.mock.calls.find(
      ([input]) => typeof input === 'string' && input.endsWith('/restore/upload'),
    );
    const init = upload?.[1];
    expect(init?.body).toBe(file);
    expect(init?.headers).toEqual({ 'content-type': 'application/octet-stream' });
    expect(upload?.[0]).toBe('/api/vault/restore/upload');
  });
});
